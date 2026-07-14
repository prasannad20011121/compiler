import { environment } from '../../environments/environment';

/** API origin — auth + project save only; never involved in code execution. */
export function apiBase(): string {
  return environment.apiBase;
}
