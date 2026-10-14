/** Actual flat credential fields consumed by the retained built-in plugins.
 * This finite storage policy never treats arbitrary suffixes as credentials. */
export const TASK_SOURCE_CREDENTIAL_FIELDS: Record<string, readonly string[]> = {
  linear: ['client_secret'], hubspot: ['client_secret', 'access_token'],
  notion: ['api_token'], youtrack: ['api_token']
}
export const TASK_SOURCE_STORED_CREDENTIAL_FIELDS = ['client_secret', 'access_token', 'api_token'] as const
