import { engineClient } from './engine'
import type { DownloadJob } from './useDownloadQueue'

export function downloadJobKey(job: Pick<DownloadJob, 'repo' | 'filename'>): string {
  return `${job.repo}::${job.filename}`
}

export function isDownloadJobActive(job: DownloadJob): boolean {
  const st = (job.status ?? '').toLowerCase()
  if (st === 'queued' || st === 'cancelled' || st === 'complete') return false
  if (st === 'error' || st.startsWith('error:')) return false
  return true
}

export async function stopDownloadJob(job: DownloadJob): Promise<void> {
  await engineClient.models.cancelDownload(job.repo, job.filename)
}

export async function stopAllDownloadJobs(jobs: DownloadJob[]): Promise<void> {
  await Promise.all(jobs.map((j) => stopDownloadJob(j)))
}
