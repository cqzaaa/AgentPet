import * as fs from 'fs'
import { dirname, join, resolve } from 'path'

export type ArtifactRole = 'final' | 'intermediate'

export interface GeneratedArtifact {
  name: string
  path: string
  size: number
  role?: ArtifactRole
}

interface ArtifactManifest {
  version: 2
  intermediatePaths: string[]
}

/**
 * Tracks generated files through one agent run. A generated file only becomes
 * intermediate when it contributes to a later generated file. Read-only
 * inspection at the end of a run therefore does not demote a deliverable.
 */
export class ArtifactTracker {
  private readonly candidates = new Map<string, GeneratedArtifact>()
  private readonly createdThisRun = new Set<string>()
  private readonly intermediatePaths = new Set<string>()
  private readonly pendingInputPaths = new Set<string>()

  private key(filePath: string): string {
    return resolve(filePath).toLocaleLowerCase()
  }

  noteSuccessfulTool(inputPaths: string[], generatedFiles: GeneratedArtifact[]): void {
    for (const inputPath of inputPaths) {
      const key = this.key(inputPath)
      this.pendingInputPaths.add(key)
      if (!this.candidates.has(key) && /[\\/]generated_files[\\/]/i.test(inputPath)) {
        try {
          const stat = fs.statSync(inputPath)
          if (stat.isFile()) {
            this.candidates.set(key, {
              name: inputPath.replace(/\\/g, '/').split('/').pop() || 'generated-file',
              path: inputPath,
              size: stat.size
            })
          }
        } catch {
          // Ignore stale input paths.
        }
      }
    }

    if (generatedFiles.length === 0) return

    const outputKeys = new Set(generatedFiles.map((file) => this.key(file.path)))
    for (const inputKey of this.pendingInputPaths) {
      if (this.candidates.has(inputKey) && !outputKeys.has(inputKey)) {
        this.intermediatePaths.add(inputKey)
      }
    }
    this.pendingInputPaths.clear()

    for (const file of generatedFiles) {
      const key = this.key(file.path)
      this.intermediatePaths.delete(key)
      this.candidates.set(key, file)
      this.createdThisRun.add(key)
    }
  }

  getFinalFiles(): GeneratedArtifact[] {
    this.persistClassification()
    return [...this.candidates.entries()]
      .filter(
        ([key, file]) =>
          this.createdThisRun.has(key) &&
          !this.intermediatePaths.has(key) &&
          fs.existsSync(file.path)
      )
      .map(([, file]) => ({ ...file, role: 'final' }))
  }

  private persistClassification(): void {
    const pathsByDirectory = new Map<string, Set<string>>()
    for (const file of this.candidates.values()) {
      if (!/[\\/]generated_files[\\/][^\\/]+$/i.test(file.path)) continue
      const directory = dirname(file.path)
      const paths = pathsByDirectory.get(directory) || new Set<string>()
      paths.add(resolve(file.path))
      pathsByDirectory.set(directory, paths)
    }

    for (const [directory, currentPaths] of pathsByDirectory) {
      const manifestPath = join(directory, '.agentpet-artifacts.json')
      const persistedIntermediatePaths = new Set<string>()
      try {
        const parsed = JSON.parse(fs.readFileSync(manifestPath, 'utf8'))
        const legacyOrCurrentPaths = [
          ...(Array.isArray(parsed?.intermediatePaths) ? parsed.intermediatePaths : []),
          ...(Array.isArray(parsed?.hiddenPaths) ? parsed.hiddenPaths : [])
        ]
        for (const item of legacyOrCurrentPaths) {
          if (typeof item === 'string') persistedIntermediatePaths.add(this.key(item))
        }
      } catch {
        // The manifest is optional on first use.
      }

      for (const filePath of currentPaths) {
        const key = this.key(filePath)
        if (this.intermediatePaths.has(key)) persistedIntermediatePaths.add(key)
        else persistedIntermediatePaths.delete(key)
      }

      const manifest: ArtifactManifest = {
        version: 2,
        intermediatePaths: [...persistedIntermediatePaths]
      }
      fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2), 'utf8')
    }
  }
}
