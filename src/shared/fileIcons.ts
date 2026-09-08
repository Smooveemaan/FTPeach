import { lookupByUnknownKey } from './lang.ts';
import type { FileEntry } from './types.ts';

const FILE_ICON_BY_EXT = {
  jpg: 'fileImage',
  jpeg: 'fileImage',
  png: 'fileImage',
  gif: 'fileImage',
  bmp: 'fileImage',
  svg: 'fileImage',
  webp: 'fileImage',
  ico: 'fileImage',
  tif: 'fileImage',
  tiff: 'fileImage',
  zip: 'fileArchive',
  rar: 'fileArchive',
  '7z': 'fileArchive',
  tar: 'fileArchive',
  gz: 'fileArchive',
  bz2: 'fileArchive',
  xz: 'fileArchive',
  js: 'fileCode',
  jsx: 'fileCode',
  ts: 'fileCode',
  tsx: 'fileCode',
  py: 'fileCode',
  java: 'fileCode',
  c: 'fileCode',
  cpp: 'fileCode',
  h: 'fileCode',
  cs: 'fileCode',
  go: 'fileCode',
  rs: 'fileCode',
  rb: 'fileCode',
  php: 'fileCode',
  html: 'fileCode',
  css: 'fileCode',
  json: 'fileCode',
  xml: 'fileCode',
  yml: 'fileCode',
  yaml: 'fileCode',
  sh: 'fileCode',
  ps1: 'fileCode',
  sql: 'fileCode',
  vue: 'fileCode',
  cjs: 'fileCode',
  mjs: 'fileCode',
  txt: 'fileText',
  md: 'fileText',
  doc: 'fileText',
  docx: 'fileText',
  rtf: 'fileText',
  log: 'fileText',
  pdf: 'fileText',
  xls: 'fileSpreadsheet',
  xlsx: 'fileSpreadsheet',
  csv: 'fileSpreadsheet',
  ods: 'fileSpreadsheet',
  mp3: 'fileAudio',
  wav: 'fileAudio',
  flac: 'fileAudio',
  ogg: 'fileAudio',
  m4a: 'fileAudio',
  aac: 'fileAudio',
  mp4: 'fileVideo',
  mkv: 'fileVideo',
  avi: 'fileVideo',
  mov: 'fileVideo',
  webm: 'fileVideo',
  wmv: 'fileVideo',
} as const;

type FileIconName =
  (typeof FILE_ICON_BY_EXT)[keyof typeof FILE_ICON_BY_EXT] | 'file' | 'fileFolder';

export function fileIconName(entry: Pick<FileEntry, 'name' | 'isDirectory'>): FileIconName {
  if (entry.isDirectory) return 'fileFolder';
  const dot = entry.name.lastIndexOf('.');
  if (dot <= 0 || dot === entry.name.length - 1) return 'file';
  const extension = entry.name.slice(dot + 1).toLowerCase();
  return lookupByUnknownKey(FILE_ICON_BY_EXT, extension) ?? 'file';
}
