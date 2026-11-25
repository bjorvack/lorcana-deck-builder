/** FNV-1a 32-bit over the string's UTF-16 code units, lowercased first. */
export function fnv1a32(value: string): number {
  let hash = 2166136261;
  const lower = value.toLowerCase();
  for (let i = 0; i < lower.length; i++) {
    hash = Math.imul(hash ^ lower.charCodeAt(i), 16777619) >>> 0;
  }
  return hash >>> 0;
}
