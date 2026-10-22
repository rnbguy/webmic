import assert from 'node:assert/strict'
import { runInNewContext } from 'node:vm'

const workflow = Bun.YAML.parse(await Bun.file(new URL('../.github/workflows/pages.yaml', import.meta.url)).text()) as {
  jobs: { build: { steps: { id?: string, with?: { script?: string } }[] } }
}
const script = workflow.jobs.build.steps.find(step => step.id == 'previous')!.with!.script!
type Artifact = { id: number, name: string, expired: boolean }

async function previousArtifact(artifacts: Artifact[], attempt = 2) {
  const outputs = new Map<string, string>()
  const github = {
    paginate: async (request: (params: never) => Promise<{ data: unknown }>, params: never) => (await request(params)).data,
    rest: {
      repos: {
        listDeployments: async () => ({ data: [{ id: 4 }, { id: 3 }, { id: 2 }] }),
        listDeploymentStatuses: async ({ deployment_id }: { deployment_id: number }) => ({ data: deployment_id == 4
          ? [{ state: 'failure' }]
          : [{ state: 'inactive' }, { state: 'success', log_url: `https://github.com/test/webmic/actions/runs/${deployment_id == 3 ? 1 : 3}/job/${deployment_id}` }] })
      },
      actions: {
        getJobForWorkflowRun: async ({ job_id }: { job_id: number }) => ({ data: {
          run_id: job_id == 3 ? 1 : 3, started_at: '2026-01-05T12:00:00Z'
        } }),
        listJobsForWorkflowRun: async () => ({ data: [
          { name: 'build', conclusion: 'success', completed_at: '2026-01-01T12:00:00Z', run_attempt: 1 },
          { name: 'build', conclusion: 'success', completed_at: '2026-01-05T11:59:00Z', run_attempt: attempt },
          { name: 'build', conclusion: 'success', completed_at: '2026-01-06T12:00:00Z', run_attempt: 3 }
        ] }),
        listWorkflowRunArtifacts: async ({ run_id }: { run_id: number }) => ({ data: run_id == 1
          ? artifacts : [{ id: 333, name: 'github-pages-1', expired: false }] })
      }
    }
  }
  await runInNewContext(`(async () => { ${script}\n})()`, {
    github, context: { repo: { owner: 'test', repo: 'webmic' }, runId: 1 },
    process: { env: { GITHUB_SERVER_URL: 'https://github.com' } },
    core: { info() {}, setOutput: (name: string, value: string) => outputs.set(name, value) }
  })
  return outputs
}

const artifacts = [
  { id: 111, name: 'github-pages-1', expired: false },
  { id: 222, name: 'github-pages-2', expired: false },
  { id: 444, name: 'github-pages-3', expired: false }
]
const rollback = await previousArtifact(artifacts)
assert.equal(rollback.get('run-id'), '1', 'An older run redeployed after a newer run owns the previous deployed graph')
assert.equal(rollback.get('artifact-id'), '222', 'Use the completed build behind that deployment, not an earlier attempt or a later rebuild')
await assert.rejects(previousArtifact([artifacts[0], artifacts[2]]), /missing or expired/, 'Do not fall back to another build attempt when the deployed archive is missing')
await assert.rejects(previousArtifact([artifacts[0], { ...artifacts[1], expired: true }]), /missing or expired/)
assert.equal((await previousArtifact([{ id: 123, name: 'github-pages', expired: false }], 1)).get('artifact-id'), '123', 'Import the existing published first-attempt archive during the retention cutover')
console.info('Pages checks passed: rollback deployment order, pending deployments, rerun build ownership, missing archives and published-archive cutover')
