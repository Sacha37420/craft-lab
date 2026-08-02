import { AfterViewInit, Component, ElementRef, input, OnChanges, ViewChild } from '@angular/core';
import { GeneratedCell } from '../../../shared/world/terrain-generation';

const CELL_SIZE = 6;

/** Rendu canvas de l'aperçu de génération — un pixel-bloc par cellule, sans interaction (validation visuelle uniquement). */
@Component({
  selector: 'app-terrain-preview',
  standalone: true,
  template: `<canvas #canvas [width]="canvasWidth()" [height]="canvasHeight()" class="terrain-preview-canvas"></canvas>`,
})
export class TerrainPreviewComponent implements AfterViewInit, OnChanges {
  rows = input.required<GeneratedCell[][]>();

  @ViewChild('canvas') private canvasRef?: ElementRef<HTMLCanvasElement>;

  canvasWidth(): number {
    return (this.rows()[0]?.length ?? 0) * CELL_SIZE;
  }

  canvasHeight(): number {
    return this.rows().length * CELL_SIZE;
  }

  ngAfterViewInit(): void {
    this.draw();
  }

  ngOnChanges(): void {
    this.draw();
  }

  private draw(): void {
    const canvas = this.canvasRef?.nativeElement;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    ctx.clearRect(0, 0, canvas.width, canvas.height);
    const rows = this.rows();
    for (let y = 0; y < rows.length; y++) {
      const row = rows[y];
      for (let x = 0; x < row.length; x++) {
        const cell = row[x];
        if (cell.kind === 'void') continue;
        ctx.fillStyle = cell.color;
        ctx.fillRect(x * CELL_SIZE, y * CELL_SIZE, CELL_SIZE, CELL_SIZE);
      }
    }
  }
}
