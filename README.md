Github Action to update helm values file during your build pipeline. 

- Updates image tags
- Creates PR and merges it

Usage:

```
- name: Update Deployment
  uses: jcputter/gitops-update@main
  with:
    token: GithubAPIToken
    filename: charts/services/yourService/values-dev.yaml
    tag: containerTag
    service: yourService
    environment: dev
    repo: git@github.com/userOrOrg/your-repo.git
    key: yourSSHkey
    org: YourOrganization
```
