Github Action to update helm values file during your build pipeline. 

Usage:

```
- name: Update Deployment
  uses: yourusername/gitops-update@main
  with:
    token: ${{ secrets.GIT_OPS_TOKEN }}
    filename: "charts/services/${{ secrets.SERVICE_NAME }}/values-${{ github.event.inputs.environment }}.yaml"
    tag: ${{ env.TAG }}
    service: ${{ secrets.SERVICE_NAME }}
    environment: ${{ github.event.inputs.environment }}
    repo: "git@github.com/YourOrganization/your-repo.git"
    key: ${{ secrets.GITOPS_KEY }}
    org: YourOrganization
```
