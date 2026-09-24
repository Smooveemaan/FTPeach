/**
 * i18next's `t`, narrowed to what this codebase calls it with. Two call
 * signatures rather than one optional parameter: an optional parameter also
 * accepts an explicit `undefined`, which i18next's own overloads do not, so a
 * single-signature alias stops accepting `TFunction` under
 * `exactOptionalPropertyTypes`.
 */
export interface Translate {
  (key: string): string;
  (key: string, values: Record<string, unknown>): string;
}
