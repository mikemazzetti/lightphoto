import type { ToolId } from '../model/store';
import { cropTool } from './crop';
import { bucketTool, gradientTool } from './fill';
import { handTool, zoomTool } from './navigate';
import { eyedropperTool, PAINT_TOOLS } from './paint';
import { lassoTool, marqueeEllipseTool, marqueeRectTool, polyLassoTool, wandTool } from './select';
import { shapeTools } from './shape';
import { textTool } from './text';
import { moveTool } from './transform';
import type { Tool } from './types';

const TOOLS: Record<ToolId, Tool> = {
  move: moveTool,
  marqueeRect: marqueeRectTool,
  marqueeEllipse: marqueeEllipseTool,
  lasso: lassoTool,
  lassoPoly: polyLassoTool,
  wand: wandTool,
  crop: cropTool,
  eyedropper: eyedropperTool,
  gradient: gradientTool,
  bucket: bucketTool,
  text: textTool,
  hand: handTool,
  zoom: zoomTool,
  ...shapeTools,
  ...(PAINT_TOOLS as Record<'brush' | 'pencil' | 'eraser' | 'clone' | 'heal' | 'spotHeal' | 'blur' | 'sharpen' | 'smudge' | 'dodge' | 'burn' | 'sponge', Tool>),
};

export const getTool = (id: ToolId): Tool => TOOLS[id];
