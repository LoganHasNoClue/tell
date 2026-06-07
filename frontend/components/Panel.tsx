export default function Panel({
  children,
  className = "",
  pad = true,
}: {
  children: React.ReactNode;
  className?: string;
  pad?: boolean;
}) {
  return (
    <div
      className={`panel hairline rounded-xl ${pad ? "p-3" : ""} ${className}`}
    >
      {children}
    </div>
  );
}
