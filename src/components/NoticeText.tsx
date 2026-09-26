import type { StatusNotice } from '../hooks/useStatusNotice.ts';

/**
 * A status line's message, in full or in its short form when the line is
 * tight. Screen readers always get the full text, and so does the tooltip over
 * the short one. Key it by `notice.id` so each new message restarts its fades.
 */
export default function NoticeText({ notice, short }: { notice: StatusNotice; short: boolean }) {
  return (
    <span className="notice-text" data-tooltip={short ? notice.text : undefined}>
      <span className="visually-hidden">{notice.text}</span>
      <span aria-hidden="true">{short ? notice.short : notice.text}</span>
    </span>
  );
}
