export const APP_VERSION = process.env.NEXT_PUBLIC_APP_VERSION ?? "dev";
export const APP_BUILD = process.env.NEXT_PUBLIC_APP_BUILD ?? "local";
export const APP_BUILT_AT = process.env.NEXT_PUBLIC_APP_BUILT_AT ?? "";
export const versionLabel = `v${APP_VERSION}`;
export const versionTitle = `Έκδοση ${APP_VERSION} · build ${APP_BUILD}${APP_BUILT_AT ? ` · ${APP_BUILT_AT} UTC` : ""}`;
