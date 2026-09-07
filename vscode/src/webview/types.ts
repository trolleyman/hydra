import type { components } from '../generated/protocol'

export type ViewState = {
  page: 'chat' | 'history' | 'profiles'
  profile: string
  pendingProfile?: string
  profiles: string[]
  profileLabels?: Record<string, string>
  profileValues?: Record<string, any>
  networkMode?: string
  running: boolean
  hasConversation: boolean
}

export type HistoryEntry = {
  id: string
  title: string
  provider: string
  profile: string
  updatedAt: string
}

export type HostFrame = components['schemas']['HostFrame']
export type Approval = Extract<HostFrame, { type: 'approval_request' }>
export type QuestionResult = { error?: string; version: number }
