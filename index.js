const core = require('@actions/core');
const github = require('@actions/github');
const { promises: fs } = require('fs');
const tmp = require('tmp');
const simpleGit = require('simple-git');
const yaml = require('js-yaml');
const path = require('path');
const asyncRetry = require('async-retry');
const { exec } = require('@actions/exec');
const io = require('@actions/io');

// Input validation function
const getRequiredInput = (name) => {
    const value = core.getInput(name, { required: true });
    if (!value) {
        core.setFailed(`Input required and not supplied: ${name}`);
        throw new Error(`Input required and not supplied: ${name}`);
    }
    return value;
};

// Action inputs
const githubToken = getRequiredInput('token');
const fileName = getRequiredInput('filename');
const tag = getRequiredInput('tag');
const service = getRequiredInput('service');
const environment = getRequiredInput('environment');
const repository = getRequiredInput('repo');
const organization = getRequiredInput('org');
const githubDeployKey = getRequiredInput('key');

const octokit = github.getOctokit(githubToken);

const execCommand = async (command, args = []) => {
    let output = '';
    let error = '';
    const options = {
        listeners: {
            stdout: (data) => {
                output += data.toString();
            },
            stderr: (data) => {
                error += data.toString();
            }
        }
    };

    try {
        await exec(command, args, options);
        return output.trim();
    } catch (err) {
        throw new Error(`Command failed: ${error}`);
    }
};

const configureGitUser = async (email, name) => {
    await execCommand('git', ['config', '--global', 'user.email', email]);
    await execCommand('git', ['config', '--global', 'user.name', name]);
};

const configureSSH = async (deployKey) => {
    const sshDir = path.join(process.env.HOME, '.ssh');
    await io.mkdirP(sshDir);
    const knownHosts = path.join(sshDir, 'known_hosts');
    const deployKeyPath = path.join(sshDir, 'id_rsa');
    const decodedPrivateKey = Buffer.from(deployKey, 'base64').toString('utf-8');
    await fs.writeFile(deployKeyPath, decodedPrivateKey, { mode: 0o600 });
    await execCommand('ssh-keyscan', ['github.com', '>>', knownHosts]);
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
        throw new Error('Unable to extract repository name.');
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
        throw error;
    }

    let data;
    try {
        data = yaml.load(fileContent);
    } catch (error) {
        core.setFailed(`Failed to parse YAML from file ${filePath}. Error: ${error.message}`);
        throw error;
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
        throw error;
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
            throw new Error(`Unexpected status code: ${response.status}`);
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
    throw new Error(`Failed to merge PR after ${maxAttempts} attempts.`);
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
        throw error;
    } finally {
        tmp.setGracefulCleanup();
    }
};

async function run() {
    try {
        const shortRepoName = getShortRepoName(repository);
        await gitCommitAndCreatePr(fileName, repository, tag, service, organization, environment);
    } catch (error) {
        core.setFailed(`Action failed: ${error.message}`);
    }
}

run();
