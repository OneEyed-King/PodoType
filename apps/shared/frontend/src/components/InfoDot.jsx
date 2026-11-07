// Small "i" hover target for a longer explanation that doesn't need to sit
// in the panel by default — keeps each header to one line. Click is
// swallowed so it doesn't also toggle whatever it happens to sit next to.
export default function InfoDot({ title }) {
  return (
    <span
      title={title}
      onClick={(e) => {
        e.preventDefault();
        e.stopPropagation();
      }}
      className="inline-flex items-center justify-center w-[13px] h-[13px] rounded-full bg-border text-muted text-[11px] italic cursor-help shrink-0"
    >
      i
    </span>
  );
}
