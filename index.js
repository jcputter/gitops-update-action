#!/usr/bin/env node

const { promises: fs } = require('fs');
const tmp = require('tmp');
const simpleGit = require('simple-git');
const axios = require('axios');
const yaml = require('js-yaml');
const path = require('path');
const asyncRetry = require('async-retry');
const { exec } = require('child_process');

const githubToken = process.env.INPUT_TOKEN;
const fileName = process.env.INPUT_FILENAME;
const tag = process.env.INPUT_TAG;
const service = process.env.INPUT_SERVICE;
const env = process.env.INPUT_ENVIRONMENT;
const repo = process.env.INPUT_REPO;
const org = process.env.INPUT_ORG;
const githubDeployKey = process.env.INPUT_KEY;

if (!githubToken) {
    console.log('GITHUB_TOKEN environment variable is not set.');
    process.exit(1);
}

if (!fileName) {
    console.log('FILENAME environment variable is not set.');
    process.exit(1);
}

if (!tag) {
    console.log('TAG environment variable is not set.');
    process.exit(1);
}

if (!env) {
    console.log('ENVIRONMENT environment variable is not set.');
    process.exit(1);
}

if (!service) {
    console.log('SERVICE environment variable is not set.');
    process.exit(1);
}

if (!repo) {
    console.log('REPO environment variable is not set.');
    process.exit(1);
}

if (!org) {
    console.log('ORG environment variable is not set.');
    process.exit(1);
}

if (!githubDeployKey) {
    console.log('GITHUB_DEPLOY_KEY environment variable is not set.');
    process.exit(1);
}

const execPromise = (command) => {
    return new Promise((resolve, reject) => {
        exec(command, (error, stdout, stderr) => {
            if (error) {
                reject(error);
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
        console.log('💩 Unable to extract repository name.');
        return null;
    }
};

const commitAndPushChanges = async (git, filename, tag, service, tmpdir, env) => {
    const filePath = path.join(tmpdir, filename);
    const branchName = `update-${env}-${service}-${tag}`;

    await git.checkoutLocalBranch(branchName);
    const fileContent = await fs.readFile(filePath, 'utf8');
    const data = yaml.load(fileContent);

    if (data.image.tag === tag) {
        console.log(`🚨 Tag already set, ${tag}`);
        return;
    }

    data.image.tag = tag;

    try {
        await fs.writeFile(filePath, yaml.dump(data), 'utf8');
    } catch (error) {
        console.log(`💩 Failed to write to file ${filePath}. Error: ${error.message}`);
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
                console.log(`🚨 Retry ${attempt} due to error: ${err.message}`);
            }
        }
    );
};

const createLabel = async (repo, labelName, labelColor, githubToken, org) => {
    const labelData = { name: labelName, color: labelColor };
    const headers = {
        Authorization: `Bearer ${githubToken}`,
        'User-Agent': 'GitOps-Update',
        Accept: 'application/vnd.github.v3+json'
    };

    const labelUrl = `https://api.github.com/repos/${org}/${repo}/labels`;

    try {
        const response = await axios.post(labelUrl, labelData, { headers });

        if (response.status === 201) {
            console.log(`✅ Label '${labelName}' created successfully.`);
            return true;
        } else if (response.status === 422) {
            console.log(`🚨 Label '${labelName}' already exists.`);
            return true;
        } else {
            console.log(`💩 Failed to create label '${labelName}'. Status Code: ${response.status}`);
            return false;
        }
    } catch (error) {
        if (error.response) {
            console.error(`💩 Failed to create label '${labelName}'. Status Code: ${error.response.status}`);
        } else {
            console.error(`💩 Failed to create label '${labelName}'. Error: ${error.message}`);
        }
        return false;
    }
};


const addLabelsToPullRequest = async (prNumber, labels, githubToken, org, repo) => {
    const labelsUrl = `https://api.github.com/repos/${org}/${repo}/issues/${prNumber}/labels`;
    const headers = {
        Authorization: `Bearer ${githubToken}`,
        Accept: 'application/vnd.github.v3+json'
    };
    const data = { labels };
    const response = await axios.post(labelsUrl, data, { headers });

    if (response.status === 200) {
        console.log(`✅ Labels added to pull request ${prNumber}`);
    } else {
        console.log(`Failed to add labels to pull request ${prNumber}. Status Code: ${response.status}, Response: ${response.data}`);
    }
};

const createPullRequest = async (repo, branchName, baseBranch, title, body, githubToken, org, deployLabel, environmentLabel) => {
    const prData = {
        title,
        head: branchName,
        base: baseBranch,
        body,
        labels: [deployLabel, environmentLabel]
    };

    const headers = {
        Authorization: `Bearer ${githubToken}`,
        'User-Agent': 'GitOps-Update',
        Accept: 'application/vnd.github.v3+json'
    };

    const prUrl = `https://api.github.com/repos/${org}/${repo}/pulls`;

    try {
        const response = await axios.post(prUrl, prData, { headers });

        if (response.status === 201) {
            const prNumber = response.data.number;
            console.log(`✅ Pull request created successfully: ${response.data.html_url}`);
            return prNumber;
        } else {
            console.log(`💩 Unexpected status code: ${response.status}, Response: ${response.data}`);
            return null;
        }
    } catch (error) {
        if (error.response) {
            if (error.response.status === 422) {
                console.log(`🚨 Pull request already exists or there is another validation error: ${error.response.data.message}`);
                return null;
            } else {
                console.error(`💩 Failed to create pull request. Status Code: ${error.response.status}, Response: ${error.response.data}`);
            }
        } else {
            console.error(`💩 Failed to create pull request. Error: ${error.message}`);
        }
        return null;
    }
};

const mergePullRequest = async (prNumber, githubToken, org, repo) => {
    const headers = { Authorization: `Bearer ${githubToken}` };
    const mergeUrl = `https://api.github.com/repos/${org}/${repo}/pulls/${prNumber}/merge`;
    const response = await axios.put(mergeUrl, {}, { headers });

    if (response.status === 200) {
        console.log('✅ Pull request merged successfully');
    } else {
        console.log(`💩 Failed to merge pull request. Status Code: ${response.status}, Response: ${response.data}`);
    }
};

const gitCommitAndCreatePr = async (filename, repo, tag, githubToken, service, org, env) => {
    console.log(`Checking out ${repo}`);
    const tmpdir = tmp.dirSync().name;
    tmp.setGracefulCleanup();

    try {
        // Configure SSH
        await configureSSH(githubDeployKey);
        await configureGitUser("jcputter@gmail.com", "JC Putter");

        // Clone the repository
        await cloneRepository(repo, tmpdir);
        const git = createGitRepo(tmpdir, repo);
        const branchName = `update-${env}-${service}-${tag}`;
        await commitAndPushChanges(git, filename, tag, service, tmpdir, env);

        const shortRepoName = getShortRepoName(repo);
        if (!shortRepoName) return;

        await createLabel(shortRepoName, 'deployment', '009800', githubToken, org);
        await createLabel(shortRepoName, env, 'FFFFFF', githubToken, org);
        await createLabel(shortRepoName, service, '0075ca', githubToken, org);

        const prNumber = await createPullRequest(shortRepoName, branchName, 'main', `chore: update ${env}-${service} to tag ${tag}`,
            `Updating ${filename} to use tag ${tag}`, githubToken, org, 'deployment', env);

        if (prNumber !== null) {
            await addLabelsToPullRequest(prNumber, ['deployment', env, service], githubToken, org, shortRepoName);
            await mergePullRequest(prNumber, githubToken, org, shortRepoName);
        }
    } finally {
        tmp.setGracefulCleanup();
    }
};

const shortRepoName = getShortRepoName(repo);
if (!shortRepoName) process.exit(1);

gitCommitAndCreatePr(fileName, repo, tag, githubToken, service, org, env);
