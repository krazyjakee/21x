import { Notification, shell } from 'electron'
import type { DatabaseManager } from '../database'
import { OAuthManager as OAuthManagerCore } from './oauth-manager-core'

/** Electron entry retains its existing default host behavior. */
export class OAuthManager extends OAuthManagerCore {
  constructor(db: DatabaseManager) {
    super(db, {
      openExternal: url => shell.openExternal(url),
      notify: (title, body) => { new Notification({ title, body }).show() }
    })
  }
}
