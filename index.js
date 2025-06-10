const core = require('@actions/core');
const github = require('@actions/github');
const { promises: fs } = require('fs');
const tmp = require('tmp');
const simpleGit = require('simple-git');
const yaml = require('js-yaml');
const path = require('path');
const asyncRetry = require('async-retry');
const { exec } = require('child_process');

const githubToken = core.getInput('token', { required: true });
const fileName = core.getInput('filename', { required: true });
const tag = core.getInput('tag', { required: true });
const service = core.getInput('service', { required: true });
const env = core.getInput('environment', { required: true });
const repo = core.getInput('repo', { required: true });
const org = core.getInput('org', { required: true });
const githubDeployKey = core.getInput('key', { required: true });

const octokit = github.getOctokit(githubToken);

const execPromise = (command) => {
    return new Promise((resolve, reject) => {
        exec(command, (error, stdout, stderr) => {
            if (error) {
                reject(new Error(stderr));
            } else {
                resolve(stdout);
            }
        });
    });
};

const configureGitUser = async (email, name) => {
    await execPromise(`git config --global user.email "${email}"`);
    await execPromise(`git config --global user.name "${name}"`);
};

const configureSSH = async (deployKey) => {
    const sshDir = path.join(process.env.HOME, '.ssh');
    await fs.mkdir(sshDir, { recursive: true });
    const knownHosts = path.join(sshDir, 'known_hosts');
    const deployKeyPath = path.join(sshDir, 'id_rsa');
    const decodedPrivateKey = Buffer.from(deployKey, 'base64').toString('utf-8');
    await fs.writeFile(deployKeyPath, decodedPrivateKey, { mode: 0o600 });
    await execPromise(`ssh-keyscan github.com >> ${knownHosts}`);
};

const cloneRepository = async (repo, tmpdir) => {
    const git = simpleGit();
    await git.clone(repo, tmpdir, { '--depth': 1 });
};

const createGitRepo = (tmpdir, repo) => {
    const git = simpleGit(tmpdir);
    git.addRemote('upstream', repo);
    return git;
};

const getShortRepoName = (repo) => {
    const match = repo.match(/\/([^\/]+)\.git$/);
    if (match) {
        return match[1];
    } else {
        core.setFailed('Unable to extract repository name.');
        return null;
    }
};

const commitAndPushChanges = async (git, filename, tag, service, tmpdir, env) => {
    const filePath = path.join(tmpdir, filename);
    const branchName = `update-${env}-${service}-${tag}`;

    await git.checkoutLocalBranch(branchName);

    let fileContent;
    try {
        fileContent = await fs.readFile(filePath, 'utf8');
    } catch (error) {
        core.setFailed(`Failed to locate ${filePath}. Chart missing or wrong environment?`);
        return;
    }

    let data;
    try {
        data = yaml.load(fileContent);
    } catch (error) {
        core.setFailed(`Failed to parse YAML from file ${filePath}. Error: ${error.message}`);
        return;
    }

    if (data.image.tag === tag) {
        core.warning(`Tag already set, ${tag}`);
        return;
    }

    data.image.tag = tag;

    try {
        await fs.writeFile(filePath, yaml.dump(data), 'utf8');
    } catch (error) {
        core.setFailed(`Failed to write to file ${filePath}. Error: ${error.message}`);
        return;
    }

    await git.add('.');
    await git.commit(`chore: updating ${env}-${service} with ${tag}`);

    await asyncRetry(
        async () => {
            await git.push('upstream', branchName);
        },
        {
            retries: 3,
            minTimeout: 5000,
            onRetry: (err, attempt) => {
                core.warning(`Retry ${attempt} due to error: ${err.message}`);
            }
        }
    );
};

const createLabel = async (repo, labelName, labelColor, org) => {
    try {
        await octokit.rest.issues.createLabel({
            owner: org,
            repo: repo,
            name: labelName,
            color: labelColor
        });
        core.info(`✅ Label '${labelName}' created successfully.`);
        return true;
    } catch (error) {
        if (error.status === 422) {
            core.info(`🚨 Label '${labelName}' already exists.`);
            return true;
        } else {
            core.error(`💩 Failed to create label '${labelName}'. Error: ${error.message}`);
            return false;
        }
    }
};

const addLabelsToPullRequest = async (prNumber, labels, org, repo) => {
    try {
        await octokit.rest.issues.addLabels({
            owner: org,
            repo: repo,
            issue_number: prNumber,
            labels: labels
        });
        core.info(`✅ Labels added to pull request ${prNumber}`);
    } catch (error) {
        core.error(`Failed to add labels to pull request ${prNumber}. Error: ${error.message}`);
    }
};

const createPullRequest = async (repo, branchName, baseBranch, title, body, org) => {
    try {
        const response = await octokit.rest.pulls.create({
            owner: org,
            repo: repo,
            title: title,
            head: branchName,
            base: baseBranch,
            body: body
        });

        if (response.status === 201) {
            const prNumber = response.data.number;
            core.info(`✅ Pull request created successfully: ${response.data.html_url}`);
            return prNumber;
        } else {
            core.error(`💩 Unexpected status code: ${response.status}`);
            return null;
        }
    } catch (error) {
        if (error.status === 422) {
            core.info('🚨 Pull request already exists');
        } else {
            core.error(`💩 Failed to create pull request. Error: ${error.message}`);
        }
        return null;
    }
};

const checkPullRequestMergeable = async (prNumber, org, repo) => {
    try {
        const response = await octokit.rest.pulls.get({
            owner: org,
            repo: repo,
            pull_number: prNumber
        });
        return response.data.mergeable;
    } catch (error) {
        core.error(`Failed to check PR mergeable status. Error: ${error.message}`);
        return false;
    }
};

const mergePullRequest = async (prNumber, org, repo) => {
    const maxAttempts = 10;
    const retryDelay = 10000;

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
        core.info(`Attempt ${attempt}: Checking if PR #${prNumber} is mergeable`);
        
        const isMergeable = await checkPullRequestMergeable(prNumber, org, repo);
        
        if (isMergeable) {
            try {
                await octokit.rest.pulls.merge({
                    owner: org,
                    repo: repo,
                    pull_number: prNumber
                });
                core.info('🚀 Pull request merged successfully');
                return;
            } catch (error) {
                core.error(`💩 Failed to merge PR. Error: ${error.message}`);
            }
        } else {
            core.info('🚨 PR is not mergeable yet.');
        }

        if (attempt < maxAttempts) {
            core.info(`Will retry in ${retryDelay / 1000} seconds...`);
            await new Promise(resolve => setTimeout(resolve, retryDelay));
        }
    }

    core.setFailed(`Failed to merge PR after ${maxAttempts} attempts.`);
};

const gitCommitAndCreatePr = async (filename, repo, tag, service, org, env) => {
    core.info(`⏳ Checking out ${repo}`);
    const tmpdir = tmp.dirSync().name;
    tmp.setGracefulCleanup();

    try {
        await configureSSH(githubDeployKey);
        await configureGitUser("jcputter@gmail.com", "JC Putter");
        await cloneRepository(repo, tmpdir);
        const git = createGitRepo(tmpdir, repo);
        const branchName = `update-${env}-${service}-${tag}`;
        await commitAndPushChanges(git, filename, tag, service, tmpdir, env);

        const shortRepoName = getShortRepoName(repo);
        if (!shortRepoName) return;

        await createLabel(shortRepoName, 'deployment', '009800', org);
        await createLabel(shortRepoName, env, 'FFFFFF', org);
        await createLabel(shortRepoName, service, '0075ca', org);

        const prNumber = await createPullRequest(shortRepoName, branchName, 'main', `chore: update ${env}-${service} to tag ${tag}`,
            `🚀 Updating ${filename} to use tag ${tag}`, org);

        if (prNumber !== null) {
            await addLabelsToPullRequest(prNumber, ['deployment', env, service], org, shortRepoName);
            await mergePullRequest(prNumber, org, shortRepoName);
        }
    } catch (error) {
        core.setFailed(`Error in gitCommitAndCreatePr: ${error.message}`);
    } finally {
        tmp.setGracefulCleanup();
    }
};

async function run() {
    try {
        const shortRepoName = getShortRepoName(repo);
        if (!shortRepoName) return;

        await gitCommitAndCreatePr(fileName, repo, tag, service, org, env);
    } catch (error) {
        core.setFailed(error.message);
    }
}

run();
