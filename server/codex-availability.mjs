import { ApiError } from "./database.mjs";

// The Codex CLI is an optional runtime dependency for the local AI chat. When
// the configured executable cannot be spawned (typically the bare `codex`
// command is not installed / not on PATH), Node rejects with ENOENT. Surface a
// readable, actionable error instead of a raw spawn message or a generic 500.
export function isCodexMissingError(error) {
  return Boolean(
    error
    && error.code === "ENOENT"
    && typeof error.message === "string",
  );
}

export function codexCliMissingError(error, executable) {
  const detail = error?.message ? String(error.message) : "executable not found";
  return new ApiError(
    503,
    "CODEX_CLI_NOT_FOUND",
    `Codex CLI 不可用（${detail}）。请安装 Codex CLI 并确认命令 '${executable}' 在 PATH 中可用，然后重试。`,
  );
}
