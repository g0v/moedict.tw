import { useEffect, useMemo, useRef } from 'react';

interface CharacterGridProps {
  text: string;
  size?: number;
}

function drawBackground(ctx: CanvasRenderingContext2D, x: number, y: number, dim: number) {
  ctx.strokeStyle = '#A33';
  ctx.fillStyle = '#F9F6F6';
  ctx.beginPath();
  ctx.lineWidth = 8;
  ctx.moveTo(x, y);
  ctx.lineTo(x, y + dim);
  ctx.lineTo(x + dim, y + dim);
  ctx.lineTo(x + dim, y);
  ctx.lineTo(x - ctx.lineWidth / 2, y);
  ctx.stroke();
  ctx.fill();

  ctx.fillStyle = '#000';
  ctx.beginPath();
  ctx.lineWidth = 2;
  ctx.moveTo(x, y + dim / 3);
  ctx.lineTo(x + dim, y + dim / 3);
  ctx.moveTo(x, y + (dim / 3) * 2);
  ctx.lineTo(x + dim, y + (dim / 3) * 2);
  ctx.moveTo(x + dim / 3, y);
  ctx.lineTo(x + dim / 3, y + dim);
  ctx.moveTo(x + (dim / 3) * 2, y);
  ctx.lineTo(x + (dim / 3) * 2, y + dim);
  ctx.stroke();
}

export function CharacterGrid({ text, size = 160 }: CharacterGridProps) {
  const canvasRefs = useRef<Array<HTMLCanvasElement | null>>([]);
  const chars = useMemo(() => Array.from(text).slice(0, 50), [text]);
  const cellSize = size;

  useEffect(() => {
    const dpr = window.devicePixelRatio || 1;
    const cellDim = cellSize * 0.94;
    const margin = cellSize * 0.03;
    const fontSize = cellDim * 0.94;

    chars.forEach((ch, index) => {
      const canvas = canvasRefs.current[index];
      if (!canvas) return;

      canvas.width = cellSize * dpr;
      canvas.height = cellSize * dpr;

      const ctx = canvas.getContext('2d');
      if (!ctx) return;
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.scale(dpr, dpr);
      ctx.clearRect(0, 0, cellSize, cellSize);

      drawBackground(ctx, margin, margin, cellDim);
      ctx.font = `${fontSize}px "Source Han Serif TC", "Noto Serif CJK TC", serif`;
      ctx.fillStyle = '#000';
      ctx.textBaseline = 'alphabetic';
      ctx.fillText(ch, margin + cellDim * 0.06, margin + cellDim * 0.82);
    });
  }, [chars, cellSize]);

  return (
    <div
      style={{
        display: 'flex',
        flexWrap: 'wrap',
        gap: Math.max(6, Math.round(cellSize * 0.06)),
        justifyContent: 'center',
      }}
    >
      {chars.map((ch, index) => (
        <canvas
          key={`${ch}-${index}`}
          ref={(el) => {
            canvasRefs.current[index] = el;
          }}
          style={{
            width: cellSize,
            height: cellSize,
            borderRadius: 10,
            boxShadow: '#d4d4d4 0 3px 3px',
            flex: '0 0 auto',
          }}
        />
      ))}
    </div>
  );
}
