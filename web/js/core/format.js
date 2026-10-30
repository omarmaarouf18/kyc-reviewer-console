// Formatting helpers: number coercion, casing and byte sizes.

export function num(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

export function upper(v, fallback) {
  return String(v || fallback).toUpperCase();
}

export function capitalize(s) {
  if (!s) return '';
  return s.charAt(0).toUpperCase() + s.slice(1);
}

export function formatBytes(bytes) {
  if (!bytes || bytes <= 0) return '0 B';
  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(1)) + ' ' + sizes[i];
}
