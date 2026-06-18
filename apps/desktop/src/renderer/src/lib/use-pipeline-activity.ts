import { engineClient } from './engine'
import { useEffect, useState } from 'react'
import type { PipelineActivity } from '../../../shared/pipeline-activity'

export function usePipelineActivity(jobId?: string): PipelineActivity | null {
  const [activity, setActivity] = useState<PipelineActivity | null>(null)

  useEffect(() => {
    void engineClient.pipeline.get().then(setActivity)
    return engineClient.pipeline.onChanged((a) => {
      if (jobId && a.jobId && a.jobId !== jobId) return
      setActivity(a)
    })
  }, [jobId])

  return activity
}
