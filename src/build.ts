import fs from "fs"
import path from "path"
import { cache } from "./git"
import { Workspace } from "./workspace"
import { HASH_FILE } from "./options"

interface PackageFiles {
  files: {
    [key: string]: string
  }
  deps: { [key: string]: number }
}

export enum ChangeType {
  added,
  deleted,
  modified,
}

export type Change = {
  file: string
  type: ChangeType
}

function getChanges(existingDeps: PackageFiles, newDeps: PackageFiles) {
  // Files
  const files = new Map(Object.entries(existingDeps.files || {}))
  const changes = new Array<Change>()
  Object.entries(newDeps.files || {}).forEach(([file, hash]) => {
    if (files.has(file)) {
      if (files.get(file) == hash) {
        files.delete(file)
      } else {
        changes.push({ file, type: ChangeType.modified })
        files.delete(file)
      }
    } else {
      changes.push({ file, type: ChangeType.added })
    }
  })
  changes.push(
    ...[...files.keys()].map((file) => ({ file, type: ChangeType.deleted }))
  )

  // Dependencies
  Object.entries(newDeps.deps).forEach(([dep, mtime]) => {
    if (!existingDeps.deps[dep])
      changes.push({ file: dep, type: ChangeType.added })
    else if (mtime === 0 || mtime !== existingDeps.deps[dep])
      changes.push({ file: dep, type: ChangeType.modified })
  })
  return changes
}

function getDependencies(root: string, workspace?: Workspace) {
  const deps: { [key: string]: number } = {}
  const pkgName = workspace?.getPackageForRoot(root)
  if (pkgName)
    workspace?.getDeps(pkgName).forEach((d) => {
      const pkg = workspace.packages.get(d)
      if (pkg && pkg.root) {
        const p = path.resolve(pkg.root, HASH_FILE)
        deps[d] = fs.existsSync(p) ? fs.lstatSync(p).mtimeMs : 0
      }
    })
  return deps
}

async function getPackageFiles(
  root: string,
  workspace: Workspace | undefined
): Promise<PackageFiles> {
  return {
    files: await cache.getFiles(root),
    deps: getDependencies(root, workspace),
  }
}

function loadPackageFiles(depsFile: string): PackageFiles {
  let ret: PackageFiles = { files: {}, deps: {} }
  if (fs.existsSync(depsFile)) {
    ret = JSON.parse(fs.readFileSync(depsFile).toString())
    if (!ret.files) ret.files = {}
    if (!ret.deps) ret.deps = {}
  }
  return ret
}

export async function needsBuild(
  root: string,
  workspace: Workspace | undefined,
  forceRebuild = false
) {
  const depsFile = path.resolve(root, HASH_FILE)
  const existingDeps: PackageFiles = forceRebuild
    ? { files: {}, deps: {} }
    : loadPackageFiles(depsFile)
  const deps = await getPackageFiles(root, workspace)

  const changes = getChanges(existingDeps, deps)

  const doBuild =
    changes.length || forceRebuild || Object.keys(deps.files).length == 0

  if (doBuild) {
    return {
      changes,
      // eslint-disable-next-line @typescript-eslint/require-await
      onBuild: async () => {
        cache.clear()
        fs.writeFileSync(
          depsFile,
          JSON.stringify(await getPackageFiles(root, workspace))
        )
      },
    }
  }
}
