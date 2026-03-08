import { useEffect, useRef } from 'react';

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
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const chars = Array.from(text).slice(0, 50);

  // Calculate grid dimensions (same algorithm as old text2dim)
  const len = Math.min(chars.length, 50);
  let w = len;
  if (w > 4) w = Math.ceil(len / Math.sqrt(len * 0.5));
  const h = Math.min(Math.ceil(len / w), w);

  const cellSize = size;
  const canvasW = w * cellSize;
  const canvasH = h * cellSize;

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    const dpr = window.devicePixelRatio || 1;
    canvas.width = canvasW * dpr;
    canvas.height = canvasH * dpr;

    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    ctx.scale(dpr, dpr);

    const cellDim = cellSize * 0.94;
    const margin = cellSize * 0.03;
    const fontSize = cellDim * 0.94;

    let charIdx = 0;
    for (let row = 0; row < h && charIdx < chars.length; row++) {
      for (let col = 0; col < w && charIdx < chars.length; col++) {
        const x = margin + col * cellSize;
        const y = margin + row * cellSize;
        drawBackground(ctx, x, y, cellDim);

        ctx.font = `${fontSize}px "Source Han Serif TC", "Noto Serif CJK TC", serif`;
        ctx.fillStyle = '#000';
        ctx.textBaseline = 'alphabetic';

        const ch = chars[charIdx];
        const offsetY = cellDim * 0.82;
        const offsetX = cellDim * 0.06;
        ctx.fillText(ch, x + offsetX, y + offsetY);

        charIdx++;
      }
    }
  }, [text, cellSize, canvasW, canvasH, w, h, chars]);

  return (
    <canvas
      ref={canvasRef}
      style={{
        width: canvasW,
        height: canvasH,
        borderRadius: 10,
        boxShadow: '#d4d4d4 0 3px 3px',
      }}
    />
  );
}
