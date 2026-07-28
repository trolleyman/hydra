// Barrel for the settings UI, split into per-section files under ./settings/.
// Kept as the stable import path for the settings pages (routes/settings.tsx and
// routes/project.$projectId/settings.tsx) while the implementation lives in the
// focused section files (theme / terminal / config / artifacts / services).
export { SettingSection, type SettingsSection } from './settings/shared'
export { ConfigForm } from './settings/ConfigForm'
export { ArtifactsEditor } from './settings/ArtifactsEditor'
export { ServicesEditor } from './settings/ServicesEditor'
export { SettingsContent } from './settings/SettingsContent'
