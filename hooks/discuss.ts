// Discuss: the text a press puts in the prompt box as the owner's own draft.
// It quotes the recorded call so Firstmate knows which one is meant; the
// owner edits and sends it, or clears it. Nothing is submitted for them.

import type { CallRecord } from '../types'

export function discussDraft(call: CallRecord): string {
  const summary = call.summary === null ? '' : ` (${call.summary})`
  const reason = call.reason === null ? '' : `\nRecorded reason: ${call.reason}`
  return `Firstmate, I want to discuss the recorded owner call ${call.key}${summary}.${reason}\nMy thoughts: `
}
