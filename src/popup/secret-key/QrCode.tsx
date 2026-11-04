import { useMemo } from "react";
import encodeQR from "qr";

const QUIET_ZONE = 2;

/** Renders a QR payload as inline SVG; the pairing payload carries no secret. */
export function QrCode({ payload, label }: { payload: string; label: string }): React.JSX.Element {
  const { size, path } = useMemo(() => {
    const modules = encodeQR(payload, "raw", { ecc: "medium" });
    let d = "";
    modules.forEach((row, y) => row.forEach((dark, x) => {
      if (dark) d += `M${x} ${y}h1v1h-1z`;
    }));
    return { size: modules.length, path: d };
  }, [payload]);
  return (
    <svg
      className="secret-key-qr"
      role="img"
      aria-label={label}
      viewBox={`${-QUIET_ZONE} ${-QUIET_ZONE} ${size + QUIET_ZONE * 2} ${size + QUIET_ZONE * 2}`}
      shapeRendering="crispEdges"
    >
      <path d={path} />
    </svg>
  );
}
