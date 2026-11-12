export interface OAuthAuthDetails {
  type: "oauth";
  /** Refresh token, optionally packed with the project id: `token|project|managedProject`. */
  refresh: string;
  access?: string;
  expires?: number;
  metadata?: Record<string, unknown>;
}

export interface RefreshParts {
  refreshToken: string;
  projectId?: string;
  managedProjectId?: string;
}

export type TokenExchangeResult =
  | { type: "success"; refresh: string; access: string; expires: number; email?: string }
  | { type: "failed"; error: string };
