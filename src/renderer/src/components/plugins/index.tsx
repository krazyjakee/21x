/**
 * Plugin Configuration Forms
 *
 * Maps plugin IDs to their custom configuration form components.
 * Each plugin can have its own unique UI, validation, and OAuth flow.
 */

import { LinearConfigForm } from './LinearConfigForm'
import { HubSpotConfigForm } from './HubSpotConfigForm'
import { GitHubIssuesConfigForm } from './GitHubIssuesConfigForm'
import { NotionConfigForm } from './NotionConfigForm'
import { YouTrackConfigForm } from './YouTrackConfigForm'
import { ConnectorBridgeConfigForm } from './ConnectorBridgeConfigForm'
import type { PluginFormProps } from './PluginFormProps'

type PluginFormComponent = React.ComponentType<PluginFormProps>

/**
 * Registry of plugin-specific configuration forms
 */
export const PLUGIN_FORMS: Record<string, PluginFormComponent> = {
  linear: LinearConfigForm,
  hubspot: HubSpotConfigForm,
  'github-issues': GitHubIssuesConfigForm,
  notion: NotionConfigForm,
  youtrack: YouTrackConfigForm,
  'connector-bridge': ConnectorBridgeConfigForm
}

/**
 * Get the configuration form component for a plugin
 */
export function getPluginForm(pluginId: string): PluginFormComponent | null {
  return PLUGIN_FORMS[pluginId] || null
}
