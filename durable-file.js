import fs from "node:fs";
import path from "node:path";
import { createHash, randomBytes } from "node:crypto";

const DEFAULT_LOCK_TIMEOUT_MS = 10_000;
const DEFAULT_LOCK_RETRY_MS = 5;
const ACTIVE_LOCK_NONCES = new Set();

function durableError(message, code = "EIO", cause) {
  const error = new Error(message, cause ? { cause } : undefined);
  error.code = code;
  return error;
}

function constantsFor(fsImpl) {
  return fsImpl.constants || fs.constants;
}

function effectiveUserId() {
  return typeof process.geteuid === "function" ? process.geteuid() : null;
}

function modeBits(stat) {
  return Number.isInteger(stat?.mode) ? stat.mode & 0o7777 : null;
}

function assertPrivateOwnerAndMode(stat, label) {
  const uid = effectiveUserId();
  const mode = modeBits(stat);
  if (uid != null && stat?.uid !== uid) {
    throw durableError(`${label} must be owned by the effective user`, "EACCES");
  }
  if (mode == null || (mode & 0o077) !== 0) {
    throw durableError(`${label} must not grant group or other permissions`, "EACCES");
  }
}

function assertSafeParentMutationBoundary(parentStat, childStat, label) {
  const parentMode = modeBits(parentStat);
  if (parentMode == null) {
    throw durableError(`${label} parent mode is unavailable`, "EACCES");
  }
  if ((parentMode & 0o022) === 0) return;
  // A sticky directory (for example /tmp) is safe for an effective-user-owned
  // child: another user with write access cannot rename or unlink that child.
  const sticky = (parentMode & 0o1000) !== 0;
  if (!sticky || (effectiveUserId() != null && childStat?.uid !== effectiveUserId())) {
    throw durableError(`${label} has a writable ancestor without a private mutation boundary`, "EACCES");
  }
}

function pathComponents(resolved) {
  const parsed = path.parse(resolved);
  const relative = path.relative(parsed.root, resolved);
  return relative && relative !== "." ? relative.split(path.sep).filter(Boolean) : [];
}

export function descriptorPath(descriptor, name = null) {
  const base = `/proc/self/fd/${descriptor}`;
  return name == null ? base : path.join(base, name);
}

export function sameFileIdentity(left, right) {
  return left?.dev === right?.dev && left?.ino === right?.ino;
}

/** A content-bound optimistic token supplements stable inode identities. */
export function durableContentDigest(value) {
  return createHash("sha256").update(value).digest("hex");
}

function readProcessStartToken(pid, { fsImpl = fs } = {}) {
  try {
    // Field 22 is the kernel start-time tick.  It prevents PID reuse from
    // making a dead lock owner look live, and is available on the same Linux
    // boundary already required for descriptor-anchored durable storage.
    const stat = fsImpl.readFileSync(`/proc/${pid}/stat`, "utf8");
    const close = stat.lastIndexOf(")");
    const fields = close === -1 ? [] : stat.slice(close + 2).trim().split(/\s+/);
    const token = fields[19];
    return /^\d+$/.test(token || "")
      ? { status: "valid", token }
      : { status: "unverifiable" };
  } catch (error) {
    // A missing /proc record proves the recorded process no longer exists.
    // Malformed data and all other errors are instead an ownership ambiguity
    // and must never authorize takeover of a retained safety lock.
    if (error?.code === "ENOENT") return { status: "missing" };
    return { status: "unverifiable", error };
  }
}

function lockRecordBytes(record) {
  return Buffer.from(JSON.stringify(record), "utf8");
}

function createSecureLockRecord(file, operation = "update", { fsImpl = fs } = {}) {
  const owner = readProcessStartToken(process.pid, { fsImpl });
  if (owner.status !== "valid") {
    throw durableError("Durable storage cannot establish lock-owner provenance", "ENOTSUP");
  }
  return {
    version: 1,
    type: "meridian-secure-file-lock",
    resourceDigest: durableContentDigest(file),
    ownerPid: process.pid,
    ownerStartToken: owner.token,
    nonce: randomBytes(32).toString("hex"),
    operation,
  };
}

function parseSecureLockRecord(bytes, file) {
  try {
    const record = JSON.parse(bytes.toString("utf8"));
    if (record?.version !== 1 || record?.type !== "meridian-secure-file-lock" ||
        record.resourceDigest !== durableContentDigest(file) ||
        !Number.isInteger(record.ownerPid) || record.ownerPid < 1 ||
        typeof record.ownerStartToken !== "string" || !/^\d+$/.test(record.ownerStartToken) ||
        typeof record.nonce !== "string" || !/^[a-f0-9]{64}$/i.test(record.nonce) ||
        typeof record.operation !== "string" || record.operation.length === 0 || record.operation.length > 128) {
      return null;
    }
    return record;
  } catch {
    return null;
  }
}

function assertLockOwnerIsInactive(record, label, { fsImpl = fs } = {}) {
  // The in-process set distinguishes a lock held by an active operation from
  // one retained after an earlier cleanup fault in this still-running process.
  if (record.ownerPid === process.pid) {
    if (ACTIVE_LOCK_NONCES.has(record.nonce)) {
      throw durableError(`${label} is actively held by this process`, "EWOULDBLOCK");
    }
    // A cleanup fault can retain a lock owned by this still-running process.
    // Once that exact nonce is no longer active, an authorized repair may
    // reclaim it. Re-checking this process's live start token would otherwise
    // incorrectly make the retained lock unrecoverable until process exit.
    return;
  }
  const observed = readProcessStartToken(record.ownerPid, { fsImpl });
  if (observed.status === "valid" && observed.token === record.ownerStartToken) {
    throw durableError(`${label} is actively held by process ${record.ownerPid}`, "EWOULDBLOCK");
  }
  if (observed.status === "missing" || observed.status === "valid") return;
  const detail = observed.error?.message ? `: ${observed.error.message}` : "";
  throw durableError(`${label} owner cannot be proven inactive${detail}`, "EUCLEAN", observed.error);
}

export function closeDescriptor(descriptor, { fsImpl = fs } = {}) {
  if (descriptor != null) fsImpl.closeSync(descriptor);
}

/**
 * Node has no openat(2), so Linux's proc descriptor view is used to anchor
 * every path component beneath an already-open directory.  Refusing to run
 * without this facility is intentional: falling back to pathname traversal
 * would reintroduce the symlink race this module protects against.
 */
export function requireSecureDescriptorSupport({ fsImpl = fs, label = "Durable storage" } = {}) {
  const { O_APPEND, O_DIRECTORY, O_NOFOLLOW, O_CREAT, O_EXCL } = constantsFor(fsImpl);
  if (process.platform !== "linux" || ![O_APPEND, O_DIRECTORY, O_NOFOLLOW, O_CREAT, O_EXCL].every(Number.isInteger)) {
    throw durableError(`${label} requires Linux O_APPEND, O_DIRECTORY, O_NOFOLLOW, and O_EXCL support`, "ENOTSUP");
  }
  try {
    fsImpl.accessSync("/proc/self/fd", constantsFor(fsImpl).R_OK | constantsFor(fsImpl).X_OK);
  } catch (error) {
    throw durableError(`${label} requires accessible /proc/self/fd: ${error.message}`, "ENOTSUP", error);
  }
}

function assertSafeBasename(name, label) {
  if (!name || path.basename(name) !== name || name === "." || name === "..") {
    throw durableError(`${label} has an invalid final filename`, "EINVAL");
  }
}

/** Open an absolute directory one component at a time without following links. */
export function openSecureDirectory(directory, {
  fsImpl = fs,
  label = "Durable storage",
  createMissing = false,
  mode = 0o700,
  requirePrivate = false,
} = {}) {
  requireSecureDescriptorSupport({ fsImpl, label });
  const resolved = path.resolve(directory);
  const parsed = path.parse(resolved);
  const constants = constantsFor(fsImpl);
  const flags = constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW;
  let descriptor = null;
  try {
    descriptor = fsImpl.openSync(parsed.root, flags);
    if (!fsImpl.fstatSync(descriptor).isDirectory()) {
      throw durableError(`${label} root descriptor is not a directory`, "ENOTDIR");
    }
    for (const component of pathComponents(resolved)) {
      const childPath = descriptorPath(descriptor, component);
      let child = null;
      let created = false;
      try {
        child = fsImpl.openSync(childPath, flags);
      } catch (error) {
        if (!createMissing || error?.code !== "ENOENT") throw error;
        try {
          fsImpl.mkdirSync(childPath, { mode });
          created = true;
        } catch (mkdirError) {
          if (mkdirError?.code !== "EEXIST") throw mkdirError;
        }
        // Persist the newly linked directory before descending into it.  A
        // later file fsync cannot make this parent directory entry durable.
        if (created) fsImpl.fsyncSync(descriptor);
        child = fsImpl.openSync(childPath, flags);
      }
      const parentStat = fsImpl.fstatSync(descriptor);
      const childStat = fsImpl.fstatSync(child);
      if (!childStat.isDirectory()) {
        throw durableError(`${label} ancestor is not a directory`, "ENOTDIR");
      }
      if (requirePrivate) assertSafeParentMutationBoundary(parentStat, childStat, label);
      closeDescriptor(descriptor, { fsImpl });
      descriptor = child;
      if (created) fsImpl.fsyncSync(descriptor);
    }
    if (requirePrivate) assertPrivateOwnerAndMode(fsImpl.fstatSync(descriptor), `${label} directory`);
    return descriptor;
  } catch (error) {
    closeDescriptor(descriptor, { fsImpl });
    if (error?.code && String(error.message || "").startsWith(`${label}`)) throw error;
    throw durableError(`Could not establish secure ${label.toLowerCase()} directory: ${error.message}`, error?.code, error);
  }
}

/**
 * Snapshot only a non-linked regular file.  The descriptor path verifies this
 * snapshot again after opening, so this preliminary pathname check is never
 * relied on by itself.
 */
export function snapshotRegularFile(filePath, {
  fsImpl = fs,
  label = "Durable storage file",
  allowMissing = false,
} = {}) {
  const file = path.resolve(filePath);
  let stat;
  try {
    stat = fsImpl.lstatSync(file);
  } catch (error) {
    if (allowMissing && error?.code === "ENOENT") return null;
    throw error;
  }
  if (stat.isSymbolicLink() || !stat.isFile()) {
    throw durableError(`${label} must be a regular file without symlinks`, "ELOOP");
  }
  if (stat.nlink !== 1) {
    throw durableError(`${label} has unexpected hard links`, "EAGAIN");
  }
  return { dev: stat.dev, ino: stat.ino, nlink: stat.nlink, size: stat.size };
}

function snapshotFromParent(parentDescriptor, name, { fsImpl, label, allowMissing = false } = {}) {
  let stat;
  try {
    stat = fsImpl.lstatSync(descriptorPath(parentDescriptor, name));
  } catch (error) {
    if (allowMissing && error?.code === "ENOENT") return null;
    throw error;
  }
  if (stat.isSymbolicLink() || !stat.isFile()) {
    throw durableError(`${label} must be a regular file without symlinks`, "ELOOP");
  }
  if (stat.nlink !== 1) {
    throw durableError(`${label} has unexpected hard links`, "EAGAIN");
  }
  return { dev: stat.dev, ino: stat.ino, nlink: stat.nlink, size: stat.size };
}

/** Verify the descriptor, anchored parent entry, and original pathname agree. */
export function verifyOpenedRegularFile(opened, {
  fsImpl = fs,
  label = "Durable storage file",
  requirePrivate = false,
} = {}) {
  const stat = fsImpl.fstatSync(opened.descriptor);
  if (!stat.isFile()) throw durableError(`${label} descriptor is not a regular file`, "ELOOP");
  if (stat.nlink !== 1) throw durableError(`${label} descriptor has unexpected hard links`, "EAGAIN");
  if (requirePrivate) assertPrivateOwnerAndMode(stat, label);

  let anchored;
  try {
    anchored = snapshotFromParent(opened.parentDescriptor, opened.name, { fsImpl, label });
  } catch (error) {
    if (error?.code === "ENOENT") {
      throw durableError(`${label} path was unlinked or renamed during access`, "EAGAIN", error);
    }
    throw error;
  }
  let named;
  try {
    named = snapshotRegularFile(opened.file, { fsImpl, label });
  } catch (error) {
    if (error?.code === "ENOENT") {
      throw durableError(`${label} original path was unlinked or renamed during access`, "EAGAIN", error);
    }
    throw error;
  }
  if (!sameFileIdentity(stat, anchored) || !sameFileIdentity(stat, named) ||
      (opened.expectedIdentity && !sameFileIdentity(stat, opened.expectedIdentity))) {
    throw durableError(`${label} path changed during access`, "EAGAIN");
  }
  return { dev: stat.dev, ino: stat.ino, nlink: stat.nlink, size: stat.size };
}

function openExistingOrCreate(filePath, {
  fsImpl = fs,
  label = "Durable storage file",
  flags,
  mode = 0o600,
  create = false,
  exclusive = false,
  expectedIdentity = undefined,
  requirePrivate = false,
} = {}) {
  const file = path.resolve(filePath);
  const name = path.basename(file);
  assertSafeBasename(name, label);
  const expected = expectedIdentity === undefined
    ? snapshotRegularFile(file, { fsImpl, label, allowMissing: create })
    : expectedIdentity;
  let parentDescriptor = null;
  let descriptor = null;
  let created = false;
  try {
    parentDescriptor = openSecureDirectory(path.dirname(file), {
      fsImpl,
      label,
      createMissing: create,
      requirePrivate,
    });
    const constants = constantsFor(fsImpl);
    const finalFlags = flags | constants.O_NOFOLLOW;
    if (expected) {
      if (exclusive) throw durableError(`${label} already exists`, "EEXIST");
      descriptor = fsImpl.openSync(descriptorPath(parentDescriptor, name), finalFlags, mode);
    } else {
      if (!create) throw durableError(`${label} is missing`, "ENOENT");
      try {
        descriptor = fsImpl.openSync(
          descriptorPath(parentDescriptor, name),
          finalFlags | constants.O_CREAT | constants.O_EXCL,
          mode,
        );
        created = true;
      } catch (error) {
        if (error?.code === "EEXIST") {
          // O_EXCL intentionally distinguishes a concurrent creation from a
          // safe pre-existing file.  Inspect the entry so a symlink/hardlink
          // is not accidentally reported as an ordinary held lease.
          snapshotFromParent(parentDescriptor, name, { fsImpl, label });
        }
        throw error;
      }
    }
    const opened = { file, name, descriptor, parentDescriptor, expectedIdentity: expected, created };
    verifyOpenedRegularFile(opened, { fsImpl, label, requirePrivate });
    return opened;
  } catch (error) {
    closeDescriptor(descriptor, { fsImpl });
    closeDescriptor(parentDescriptor, { fsImpl });
    throw error;
  }
}

export function openSecureRegularFileForRead(filePath, options = {}) {
  const { fsImpl = fs } = options;
  const constants = constantsFor(fsImpl);
  return openExistingOrCreate(filePath, {
    ...options,
    fsImpl,
    flags: constants.O_RDONLY | (constants.O_NONBLOCK ?? 0),
  });
}

export function openSecureRegularFileForAppend(filePath, options = {}) {
  const { fsImpl = fs } = options;
  const constants = constantsFor(fsImpl);
  return openExistingOrCreate(filePath, {
    ...options,
    fsImpl,
    create: true,
    flags: constants.O_RDWR | constants.O_APPEND | (constants.O_NONBLOCK ?? 0),
  });
}

/** Open a regular file for verified in-place replacement without O_APPEND. */
export function openSecureRegularFileForWrite(filePath, options = {}) {
  const { fsImpl = fs } = options;
  const constants = constantsFor(fsImpl);
  return openExistingOrCreate(filePath, {
    ...options,
    fsImpl,
    flags: constants.O_RDWR | (constants.O_NONBLOCK ?? 0),
  });
}

export function createSecureExclusiveFile(filePath, options = {}) {
  const { fsImpl = fs } = options;
  const constants = constantsFor(fsImpl);
  return openExistingOrCreate(filePath, {
    ...options,
    fsImpl,
    create: true,
    exclusive: true,
    flags: constants.O_RDWR | (constants.O_NONBLOCK ?? 0),
  });
}

export function readSecureRegularFile(filePath, {
  fsImpl = fs,
  label = "Durable storage file",
  allowMissing = false,
  requirePrivate = false,
} = {}) {
  let opened = null;
  try {
    opened = openSecureRegularFileForRead(filePath, { fsImpl, label, requirePrivate });
    const before = verifyOpenedRegularFile(opened, { fsImpl, label, requirePrivate });
    const bytes = Buffer.alloc(before.size);
    let offset = 0;
    while (offset < bytes.length) {
      const received = fsImpl.readSync(opened.descriptor, bytes, offset, bytes.length - offset, offset);
      if (!Number.isInteger(received) || received <= 0) {
        throw durableError(`${label} read made no progress`, "EIO");
      }
      offset += received;
    }
    const stat = verifyOpenedRegularFile(opened, { fsImpl, label, requirePrivate });
    if (stat.size !== before.size) {
      throw durableError(`${label} changed size during read`, "EAGAIN");
    }
    return {
      bytes,
      stat: { ...stat, contentDigest: durableContentDigest(bytes) },
    };
  } catch (error) {
    if (allowMissing && error?.code === "ENOENT") return null;
    throw error;
  } finally {
    if (opened) closeSecureRegularFile(opened, { fsImpl });
  }
}

/** Keep writing until every byte is accepted; a zero-byte write is failure. */
export function writeAllSync(descriptor, value, {
  fsImpl = fs,
  label = "Durable storage file",
  position = null,
} = {}) {
  const bytes = Buffer.isBuffer(value) ? value : Buffer.from(value);
  let offset = 0;
  while (offset < bytes.length) {
    const writePosition = position == null ? null : position + offset;
    const written = fsImpl.writeSync(descriptor, bytes, offset, bytes.length - offset, writePosition);
    if (!Number.isInteger(written) || written <= 0) {
      throw durableError(`${label} short write made no progress`, "EIO");
    }
    offset += written;
  }
}

function syncOpenedFile(opened, { fsImpl, label, durable, requirePrivate = false }) {
  if (!durable) return verifyOpenedRegularFile(opened, { fsImpl, label, requirePrivate });
  fsImpl.fsyncSync(opened.descriptor);
  verifyOpenedRegularFile(opened, { fsImpl, label, requirePrivate });
  fsImpl.fsyncSync(opened.parentDescriptor);
  // The post-directory-sync check covers a replacement that races the first
  // validation or directory flush before the caller sees success.
  return verifyOpenedRegularFile(opened, { fsImpl, label, requirePrivate });
}

function verifyOpenedExpectedContent(opened, { fsImpl, label, requirePrivate = false }) {
  const expectedDigest = opened.expectedIdentity?.contentDigest;
  if (typeof expectedDigest !== "string") return;

  const before = verifyOpenedRegularFile(opened, { fsImpl, label, requirePrivate });
  const bytes = Buffer.alloc(before.size);
  let offset = 0;
  while (offset < bytes.length) {
    const received = fsImpl.readSync(opened.descriptor, bytes, offset, bytes.length - offset, offset);
    if (!Number.isInteger(received) || received <= 0) {
      throw durableError(`${label} optimistic read made no progress`, "EIO");
    }
    offset += received;
  }
  const after = verifyOpenedRegularFile(opened, { fsImpl, label, requirePrivate });
  if (after.size !== before.size || durableContentDigest(bytes) !== expectedDigest) {
    throw durableError(`${label} content changed before write`, "EAGAIN");
  }
}

export function appendOpenedRegularFile(opened, value, {
  fsImpl = fs,
  label = "Durable storage file",
  durable = true,
  requirePrivate = false,
} = {}) {
  const before = verifyOpenedRegularFile(opened, { fsImpl, label, requirePrivate });
  try {
    writeAllSync(opened.descriptor, value, { fsImpl, label });
    syncOpenedFile(opened, { fsImpl, label, durable, requirePrivate });
  } catch (error) {
    // A failed append must not leave a valid-looking partial JSONL tail.  If
    // rollback itself fails, callers still fail closed on the unterminated
    // record and receive the original error with that fact attached.
    try {
      fsImpl.ftruncateSync(opened.descriptor, before.size);
      if (durable) fsImpl.fsyncSync(opened.descriptor);
    } catch {
      error.message = `${error.message}; durable append rollback failed`;
    }
    throw error;
  }
}

export function writeOpenedRegularFile(opened, value, {
  fsImpl = fs,
  label = "Durable storage file",
  durable = true,
  requirePrivate = false,
} = {}) {
  const before = verifyOpenedRegularFile(opened, { fsImpl, label, requirePrivate });
  try {
    // In-place rewrites preserve dev/ino, so writers that loaded an older
    // state need a content token as well as the descriptor identity check.
    verifyOpenedExpectedContent(opened, { fsImpl, label, requirePrivate });
    fsImpl.ftruncateSync(opened.descriptor, 0);
    writeAllSync(opened.descriptor, value, { fsImpl, label, position: 0 });
    return syncOpenedFile(opened, { fsImpl, label, durable, requirePrivate });
  } catch (error) {
    try {
      fsImpl.ftruncateSync(opened.descriptor, before.size);
      if (durable) fsImpl.fsyncSync(opened.descriptor);
    } catch {
      error.message = `${error.message}; durable file rollback failed`;
    }
    throw error;
  }
}

export function closeSecureRegularFile(opened, { fsImpl = fs } = {}) {
  if (!opened) return;
  closeDescriptor(opened.descriptor, { fsImpl });
  closeDescriptor(opened.parentDescriptor, { fsImpl });
}

function pauseSync(milliseconds) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, milliseconds);
}

function lockNameFor(filePath, suffix) {
  return `.${path.basename(filePath)}.${suffix}.lock`;
}

/**
 * An O_EXCL lock is deliberately never stolen.  A crash leaves a durable,
 * manual-recovery condition rather than allowing concurrent writers to guess
 * whether an interrupted operation completed.
 */
export function acquireSecureFileLock(filePath, {
  fsImpl = fs,
  label = "Durable storage",
  lockName = lockNameFor(filePath, "update"),
  durable = true,
  timeoutMs = DEFAULT_LOCK_TIMEOUT_MS,
  retryMs = DEFAULT_LOCK_RETRY_MS,
  requirePrivate = false,
} = {}) {
  const file = path.resolve(filePath);
  assertSafeBasename(lockName, `${label} lock`);
  const deadline = Date.now() + timeoutMs;
  const constants = constantsFor(fsImpl);
  const flags = constants.O_RDWR | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW;
  while (true) {
    let parentDescriptor = null;
    let descriptor = null;
    try {
      parentDescriptor = openSecureDirectory(path.dirname(file), {
        fsImpl,
        label,
        createMissing: true,
        requirePrivate,
      });
      descriptor = fsImpl.openSync(descriptorPath(parentDescriptor, lockName), flags, 0o600);
      const opened = {
        file: path.join(path.dirname(file), lockName),
        name: lockName,
        descriptor,
        parentDescriptor,
        expectedIdentity: null,
        created: true,
      };
      verifyOpenedRegularFile(opened, { fsImpl, label: `${label} lock`, requirePrivate });
      // Locks carry only enough local provenance to distinguish a dead owner
      // from a live writer during the separately authorized repair path. The
      // lock remains an O_EXCL pathname mutex for all ordinary operations.
      const record = createSecureLockRecord(file, "update", { fsImpl });
      writeAllSync(descriptor, lockRecordBytes(record), { fsImpl, label: `${label} lock`, position: 0 });
      if (durable) {
        fsImpl.fsyncSync(descriptor);
        fsImpl.fsyncSync(parentDescriptor);
        verifyOpenedRegularFile(opened, { fsImpl, label: `${label} lock`, requirePrivate });
      }
      opened.record = record;
      ACTIVE_LOCK_NONCES.add(record.nonce);
      return opened;
    } catch (error) {
      closeDescriptor(descriptor, { fsImpl });
      closeDescriptor(parentDescriptor, { fsImpl });
      if (error?.code !== "EEXIST") throw error;
      // Inspect the conflicting entry so a link attack never becomes a
      // harmless-looking busy lock.
      try {
        const parent = openSecureDirectory(path.dirname(file), {
          fsImpl,
          label,
          createMissing: true,
          requirePrivate,
        });
        try {
          snapshotFromParent(parent, lockName, { fsImpl, label: `${label} lock` });
        } finally {
          closeDescriptor(parent, { fsImpl });
        }
      } catch (inspectionError) {
        if (inspectionError?.code !== "ENOENT") throw inspectionError;
      }
      if (Date.now() >= deadline) {
        throw durableError(`Timed out waiting for ${label.toLowerCase()} lock`, "EWOULDBLOCK", error);
      }
      pauseSync(retryMs);
    }
  }
}

function readOpenedRegularFileBytes(opened, { fsImpl, label, requirePrivate = false }) {
  const before = verifyOpenedRegularFile(opened, { fsImpl, label, requirePrivate });
  const bytes = Buffer.alloc(before.size);
  let offset = 0;
  while (offset < bytes.length) {
    const received = fsImpl.readSync(opened.descriptor, bytes, offset, bytes.length - offset, offset);
    if (!Number.isInteger(received) || received <= 0) {
      throw durableError(`${label} read made no progress`, "EIO");
    }
    offset += received;
  }
  const after = verifyOpenedRegularFile(opened, { fsImpl, label, requirePrivate });
  if (after.size !== before.size) throw durableError(`${label} changed size during read`, "EAGAIN");
  return { bytes, stat: after };
}

/**
 * Claim a stale, provenance-bearing lock without unlinking its pathname.
 * This is intentionally separate from ordinary acquisition: callers must
 * establish their own operator authorization before calling it, and a live,
 * foreign, malformed, or changed lock is never taken over.
 */
export function claimRetainedSecureFileLock(filePath, {
  fsImpl = fs,
  label = "Durable storage",
  lockName = lockNameFor(filePath, "update"),
  durable = true,
  requirePrivate = false,
} = {}) {
  const file = path.resolve(filePath);
  assertSafeBasename(lockName, `${label} lock`);
  const lockPath = path.join(path.dirname(file), lockName);
  let opened = null;
  try {
    opened = openSecureRegularFileForWrite(lockPath, {
      fsImpl,
      label: `${label} retained lock`,
      requirePrivate,
    });
    const current = readOpenedRegularFileBytes(opened, {
      fsImpl,
      label: `${label} retained lock`,
      requirePrivate,
    });
    // Descriptor identity alone does not catch an in-place replacement of the
    // retained-lock record; bind the subsequent takeover write to these bytes.
    opened.expectedIdentity = { ...opened.expectedIdentity, contentDigest: durableContentDigest(current.bytes) };
    const record = parseSecureLockRecord(current.bytes, file);
    if (record == null) {
      throw durableError(`${label} retained lock is unprovable or belongs to a different resource`, "EUCLEAN");
    }
    assertLockOwnerIsInactive(record, `${label} retained lock`, { fsImpl });

    const claim = createSecureLockRecord(file, "operator_durability_repair", { fsImpl });
    writeOpenedRegularFile(opened, lockRecordBytes(claim), {
      fsImpl,
      label: `${label} retained lock`,
      durable,
      requirePrivate,
    });
    opened.record = claim;
    ACTIVE_LOCK_NONCES.add(claim.nonce);
    return opened;
  } catch (error) {
    if (opened) closeSecureRegularFile(opened, { fsImpl });
    throw error;
  }
}

export function releaseSecureFileLock(lock, {
  fsImpl = fs,
  label = "Durable storage",
  durable = true,
  requirePrivate = false,
} = {}) {
  if (!lock) return;
  let releaseError = null;
  let unlinked = false;
  let postUnlinkDirectorySyncDiagnostic = null;
  try {
    verifyOpenedRegularFile(lock, { fsImpl, label: `${label} lock`, requirePrivate });
    fsImpl.unlinkSync(descriptorPath(lock.parentDescriptor, lock.name));
    unlinked = true;
    if (durable) {
      try {
        fsImpl.fsyncSync(lock.parentDescriptor);
      } catch (error) {
        // The lock pathname was successfully removed. This directory-fsync
        // failure cannot roll back an already committed state/marker pair, but
        // callers receive an explicit committed diagnostic instead of a
        // silently hidden cleanup fault.
        postUnlinkDirectorySyncDiagnostic = error;
      }
    }
  } catch (error) {
    releaseError = error;
  } finally {
    try {
      closeSecureRegularFile(lock, { fsImpl });
    } catch (closeError) {
      // A close error is not equivalent to the sole safe diagnostic above:
      // it can obscure lock-descriptor integrity and must be surfaced.
      releaseError ||= closeError;
    }
    if (lock.record?.nonce) ACTIVE_LOCK_NONCES.delete(lock.record.nonce);
  }
  if (releaseError) {
    releaseError.lockUnlinked = unlinked;
    releaseError.cleanupLockState = unlinked ? "absent" : "retained_or_unknown";
    throw releaseError;
  }
  return {
    released: unlinked,
    diagnostic: postUnlinkDirectorySyncDiagnostic,
    diagnosticCode: postUnlinkDirectorySyncDiagnostic ? "LOCK_DIRECTORY_FSYNC_AFTER_UNLINK" : null,
    cleanupLockState: unlinked ? "absent" : "retained_or_unknown",
  };
}

/**
 * Stop owning a claimed retained lock without unlinking its pathname. This is
 * used only when an authorized repair has not yet established a known durable
 * safe latch: preserving the pathname leaves ordinary readers fail-closed and
 * allows a later authorized repair to re-prove and retry the same record.
 */
export function retainSecureFileLock(lock, { fsImpl = fs } = {}) {
  if (!lock) return { released: false, cleanupLockState: "retained_or_unknown" };
  let closeError = null;
  try {
    closeDescriptor(lock.descriptor, { fsImpl });
  } catch (error) {
    closeError = error;
  }
  try {
    closeDescriptor(lock.parentDescriptor, { fsImpl });
  } catch (error) {
    closeError ||= error;
  }
  if (lock.record?.nonce) ACTIVE_LOCK_NONCES.delete(lock.record.nonce);
  if (closeError) {
    closeError.lockUnlinked = false;
    closeError.cleanupLockState = "retained_or_unknown";
    throw closeError;
  }
  return { released: false, cleanupLockState: "retained_or_unknown" };
}

/**
 * Reads may not proceed while any update lock exists. A retained lock is a
 * crash/ownership ambiguity, not an ordinary retry signal for a safety latch.
 */
export function assertNoSecureFileLock(filePath, {
  fsImpl = fs,
  label = "Durable storage",
  lockName = lockNameFor(filePath, "update"),
  requirePrivate = false,
} = {}) {
  const file = path.resolve(filePath);
  assertSafeBasename(lockName, `${label} lock`);
  const lockPath = path.join(path.dirname(file), lockName);
  const source = readSecureRegularFile(lockPath, {
    fsImpl,
    label: `${label} lock`,
    allowMissing: true,
    requirePrivate,
  });
  if (source != null) {
    throw durableError(`${label} has a retained or in-flight update lock; explicit operator recovery is required`, "EWOULDBLOCK");
  }
}

export function removeOpenedRegularFile(opened, {
  fsImpl = fs,
  label = "Durable storage file",
  durable = true,
} = {}) {
  verifyOpenedRegularFile(opened, { fsImpl, label });
  fsImpl.unlinkSync(descriptorPath(opened.parentDescriptor, opened.name));
  if (durable) fsImpl.fsyncSync(opened.parentDescriptor);
}

/**
 * A durable uncertainty marker is a retained two-phase record for an in-place
 * state rewrite. The marker is separate from the state inode so a failed fsync
 * cannot leave a syntactically valid, permissive replacement as the only
 * durable evidence a restarted reader sees.
 */
export function durabilityUncertaintyMarkerPath(filePath) {
  const file = path.resolve(filePath);
  return path.join(path.dirname(file), `.${path.basename(file)}.durability-uncertain`);
}

function markerRecord(phase, stateDigest = null) {
  return Buffer.from(JSON.stringify({ version: 1, phase, stateDigest }), "utf8");
}

function parseCommittedMarker(bytes) {
  try {
    const parsed = JSON.parse(bytes.toString("utf8"));
    if (parsed?.version !== 1 || parsed?.phase !== "committed" ||
        typeof parsed.stateDigest !== "string" || !/^[a-f0-9]{64}$/i.test(parsed.stateDigest)) {
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
}

/**
 * Refuse to read state while a prior durable rewrite may have failed. A
 * committed marker is retained instead of unlinked: it is accepted only when
 * its digest proves it belongs to the exact state bytes the caller read.
 * Retention avoids the verify-then-unlink pathname race entirely.
 */
export function assertNoDurabilityUncertaintyMarker(filePath, {
  fsImpl = fs,
  label = "Durable storage file",
  expectedValue = undefined,
  requirePrivate = false,
} = {}) {
  const markerPath = durabilityUncertaintyMarkerPath(filePath);
  const source = readSecureRegularFile(markerPath, {
    fsImpl,
    label: `${label} durability marker`,
    allowMissing: true,
    requirePrivate,
  });
  // Before this protocol creates a state, both state and marker are absent.
  // Once bytes exist, a missing marker is deletion/tampering evidence rather
  // than a safe legacy state and must keep entry closed.
  if (source == null) {
    if (expectedValue === undefined) return null;
    throw durableError(`${label} is missing its committed durability marker; explicit safe repair is required`, "EUCLEAN");
  }
  const committed = parseCommittedMarker(source.bytes);
  if (expectedValue !== undefined && committed &&
      committed.stateDigest === durableContentDigest(expectedValue)) {
    return committed;
  }
  throw durableError(
    `${label} has an unresolved durability-uncertainty marker; explicit safe repair is required`,
    "EUCLEAN",
  );
}

function openDurabilityUncertaintyMarker(filePath, {
  fsImpl,
  label,
  durable,
  requirePrivate = false,
} = {}) {
  const markerPath = durabilityUncertaintyMarkerPath(filePath);
  let marker = null;
  try {
    marker = openSecureRegularFileForWrite(markerPath, {
      fsImpl,
      label: `${label} durability marker`,
      create: true,
      requirePrivate,
    });
    // This durable poison transition happens before any target truncation.
    // A failure here leaves either the previous committed marker (the target
    // is untouched) or an unreadable/uncertain marker, both of which are
    // fail-closed for the next target read.
    writeOpenedRegularFile(marker, markerRecord("uncertain"), {
      fsImpl,
      label: `${label} durability marker`,
      durable,
      requirePrivate,
    });
    return marker;
  } catch (error) {
    if (marker) closeSecureRegularFile(marker, { fsImpl });
    throw error;
  }
}

function replaceSecureFileInPlace(filePath, value, {
  fsImpl,
  label,
  durable,
  expectedIdentity,
  requirePrivate = false,
} = {}) {
  let opened = null;
  try {
    opened = openSecureRegularFileForWrite(filePath, {
      fsImpl,
      label,
      create: true,
      expectedIdentity,
      requirePrivate,
    });
    return writeOpenedRegularFile(opened, value, { fsImpl, label, durable, requirePrivate });
  } finally {
    if (opened) closeSecureRegularFile(opened, { fsImpl });
  }
}

function readCurrentSecureFile(filePath, { fsImpl, label, requirePrivate = false }) {
  return readSecureRegularFile(filePath, { fsImpl, label, allowMissing: true, requirePrivate });
}

function assertExpectedCurrentFile(source, expectedIdentity, { label }) {
  if (expectedIdentity == null) {
    if (source != null) throw durableError(`${label} appeared before write`, "EAGAIN");
    return;
  }
  if (source == null || !sameFileIdentity(source.stat, expectedIdentity) ||
      (typeof expectedIdentity.contentDigest === "string" &&
       source.stat.contentDigest !== expectedIdentity.contentDigest)) {
    throw durableError(`${label} changed before write`, "EAGAIN");
  }
}

function commitDurabilityMarker(marker, stateValue, { fsImpl, label, durable, requirePrivate = false }) {
  writeOpenedRegularFile(marker, markerRecord("committed", durableContentDigest(stateValue)), {
    fsImpl,
    label: `${label} durability marker`,
    durable,
    requirePrivate,
  });
}

/**
 * Persist a state file through the inode that was verified against its path.
 *
 * Renaming a prepared temporary file has an unavoidable last pathname race in
 * Node: another actor can replace the destination after the pre-rename check
 * and before rename(2), causing us to overwrite that newer path.  Existing
 * files are therefore rewritten in place under the caller's durable lock.
 * Every write verifies descriptor/path identity before and after persistence;
 * a replacement race writes only the unlinked old inode and is reported as an
 * error.  A crash during that in-place rewrite may leave invalid state, which
 * consumers intentionally reject rather than treating as a valid update. A
 * caller can additionally request `durabilityMarker` to protect consumers
 * that must also reject a valid-looking state whose final fsync failed.
 */
export function atomicReplaceSecureFile(filePath, value, {
  fsImpl = fs,
  label = "Durable storage file",
  durable = true,
  expectedIdentity = undefined,
  durabilityMarker = false,
  requirePrivate = false,
} = {}) {
  const file = path.resolve(filePath);
  const name = path.basename(file);
  assertSafeBasename(name, label);
  const current = readCurrentSecureFile(file, { fsImpl, label, requirePrivate });
  const expected = expectedIdentity === undefined
    ? (current?.stat ?? null)
    : expectedIdentity;
  assertExpectedCurrentFile(current, expected, { label });
  const bytes = Buffer.isBuffer(value) ? value : Buffer.from(value);

  if (!durabilityMarker) {
    const stat = replaceSecureFileInPlace(file, bytes, {
      fsImpl,
      label,
      durable,
      expectedIdentity: expected,
      requirePrivate,
    });
    return { ...stat, contentDigest: durableContentDigest(bytes) };
  }

  // Existing committed markers are part of the normal protocol. They can be
  // reused only after proving that they attest to the exact current state.
  assertNoDurabilityUncertaintyMarker(file, {
    fsImpl,
    label,
    expectedValue: current?.bytes,
    requirePrivate,
  });
  let marker = null;
  try {
    marker = openDurabilityUncertaintyMarker(file, { fsImpl, label, durable, requirePrivate });
    // The marker is now durably uncertain. A target failure intentionally
    // leaves it unresolved so both current and restarted readers deny entry.
    const stat = replaceSecureFileInPlace(file, bytes, {
      fsImpl,
      label,
      durable,
      expectedIdentity: expected,
      requirePrivate,
    });
    // Do not unlink this marker. A hash-bound committed record survives the
    // target write without a verify-then-unlink race. A failed commit remains
    // fail-closed as an uncertain or corrupt marker.
    commitDurabilityMarker(marker, bytes, { fsImpl, label, durable, requirePrivate });
    return { ...stat, contentDigest: durableContentDigest(bytes) };
  } finally {
    if (marker) closeSecureRegularFile(marker, { fsImpl });
  }
}

/**
 * Replace an unresolved marker only by publishing caller-supplied safe state.
 * This deliberately never removes a pathname; callers must hold their own
 * authorization boundary and should use a state that remains fail-closed.
 */
export function repairDurabilityUncertaintyMarker(filePath, value, {
  fsImpl = fs,
  label = "Durable storage file",
  durable = true,
  requirePrivate = false,
} = {}) {
  const file = path.resolve(filePath);
  const markerPath = durabilityUncertaintyMarkerPath(file);
  const current = readCurrentSecureFile(file, { fsImpl, label, requirePrivate });
  const expected = current?.stat ?? null;
  let marker = null;
  try {
    // This function is only called through an operator-authorized repair
    // boundary. It deliberately recreates a missing/corrupt marker as
    // uncertain before publishing a fresh fail-closed state.
    marker = openSecureRegularFileForWrite(markerPath, {
      fsImpl,
      label: `${label} durability marker`,
      create: true,
      requirePrivate,
    });
    writeOpenedRegularFile(marker, markerRecord("uncertain"), {
      fsImpl,
      label: `${label} durability marker`,
      durable,
      requirePrivate,
    });
    const bytes = Buffer.isBuffer(value) ? value : Buffer.from(value);
    const stat = replaceSecureFileInPlace(file, bytes, {
      fsImpl,
      label,
      durable,
      expectedIdentity: expected,
      requirePrivate,
    });
    commitDurabilityMarker(marker, bytes, { fsImpl, label, durable, requirePrivate });
    return { ...stat, contentDigest: durableContentDigest(bytes) };
  } finally {
    if (marker) closeSecureRegularFile(marker, { fsImpl });
  }
}
