import { describe, expect, it } from 'vitest'
import { ArtifactType, artifactWorkpieceForPath } from './artifacts'

const isDeliverable = (path: string, type: ArtifactType): boolean =>
  artifactWorkpieceForPath(path, type) !== null

describe('artifact deliverable boundary', () => {
  it('keeps repository source and documentation out of artifact tabs', () => {
    expect(isDeliverable('20x/src/App.tsx', ArtifactType.FILE)).toBe(false)
    expect(isDeliverable('20x/docs/architecture.md', ArtifactType.MARKDOWN)).toBe(false)
    expect(isDeliverable('20x/public/index.html', ArtifactType.HTML)).toBe(false)
  })

  it('accepts standalone previews and explicit deliverable directories', () => {
    expect(isDeliverable('summary.md', ArtifactType.MARKDOWN)).toBe(true)
    expect(isDeliverable('outputs/demo/index.html', ArtifactType.HTML)).toBe(true)
    expect(isDeliverable('repo/reports/data.json', ArtifactType.FILE)).toBe(true)
    expect(isDeliverable('.20x/artifacts/chart.png', ArtifactType.IMAGE)).toBe(true)
  })

  it('does not promote a generic root source file', () => {
    expect(isDeliverable('package.json', ArtifactType.FILE)).toBe(false)
  })

  it('groups supporting files beneath one named output workpiece', () => {
    expect(artifactWorkpieceForPath('outputs/dashboard/index.html', ArtifactType.HTML)).toEqual({
      key: 'outputs/dashboard',
      title: 'dashboard',
      grouped: true
    })
    expect(artifactWorkpieceForPath('outputs/dashboard/styles.css', ArtifactType.FILE)).toEqual({
      key: 'outputs/dashboard',
      title: 'dashboard',
      grouped: true
    })
  })
})
