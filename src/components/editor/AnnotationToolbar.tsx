import { memo } from "react";
import { Circle, Square, Minus, ArrowUpRight, Type, Hash, MousePointer2, Trash2, Scan, Crop, FileText, Loader2, Check } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import { ToolType } from "@/types/annotations";
import { cn } from "@/lib/utils";

interface AnnotationToolbarProps {
  selectedTool: ToolType;
  onToolSelect: (tool: ToolType) => void;
  onDelete?: () => void;
  onExtractText?: () => void;
  isExtracting?: boolean;
  onSave?: () => void;
  isSaving?: boolean;
  hasChanges?: boolean;
  color?: string;
  onColorChange?: (hex: string) => void;
}

const tools: Array<{ type: ToolType; icon: React.ReactNode; label: string }> = [
  { type: "select", icon: <MousePointer2 className="size-4" />, label: "Select" },
  { type: "circle", icon: <Circle className="size-4" />, label: "Circle" },
  { type: "rectangle", icon: <Square className="size-4" />, label: "Rectangle" },
  { type: "line", icon: <Minus className="size-4" />, label: "Line" },
  { type: "arrow", icon: <ArrowUpRight className="size-4" />, label: "Arrow" },
  { type: "number", icon: <Hash className="size-4" />, label: "Number" },
  { type: "text", icon: <Type className="size-4" />, label: "Text" },
  { type: "blur", icon: <Scan className="size-4" />, label: "Blur an area" },
  { type: "crop", icon: <Crop className="size-4" />, label: "Crop — drag, adjust handles, Enter" },
];

export const AnnotationToolbar = memo(function AnnotationToolbar({ selectedTool, onToolSelect, onDelete, onExtractText, isExtracting, onSave, isSaving, hasChanges, color = "#FF3300", onColorChange }: AnnotationToolbarProps) {
  return (
    <TooltipProvider delayDuration={200}>
      <div
        data-tauri-drag-region
        className="flex items-center gap-1 pl-[88px] pr-3 h-11 bg-black border-b border-white/5"
      >
        <div data-tauri-drag-region className="flex-1 h-full" />
        <div className="flex items-center gap-1">
          {tools.map((tool) => (
            <Tooltip key={tool.type}>
              <TooltipTrigger asChild>
                <Button
                  variant="ghost"
                  size="icon"
                  onClick={() => onToolSelect(tool.type)}
                  className={cn(
                    "size-8 rounded-md",
                    selectedTool === tool.type
                      ? "bg-white/10 text-foreground"
                      : "text-muted-foreground hover:text-foreground hover:bg-white/5"
                  )}
                  aria-label={tool.label}
                >
                  {tool.icon}
                </Button>
              </TooltipTrigger>
              <TooltipContent side="bottom" className="text-xs">
                {tool.label}
              </TooltipContent>
            </Tooltip>
          ))}
          {onColorChange && (
            <Tooltip>
              <TooltipTrigger asChild>
                <label
                  className="relative size-8 rounded-md grid place-items-center cursor-pointer hover:bg-white/5"
                  aria-label="Pick color"
                >
                  <span
                    className="size-4 rounded-full border border-white/30 shadow-inner"
                    style={{ backgroundColor: color }}
                  />
                  <input
                    type="color"
                    value={color}
                    onChange={(e) => onColorChange(e.target.value)}
                    className="absolute inset-0 size-full cursor-pointer opacity-0"
                  />
                </label>
              </TooltipTrigger>
              <TooltipContent side="bottom" className="text-xs">
                Color
              </TooltipContent>
            </Tooltip>
          )}
        </div>
        <div className="ml-1 flex items-center gap-1">
          {onSave && hasChanges && (
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  variant="ghost"
                  size="icon"
                  onClick={onSave}
                  disabled={isSaving}
                  className="size-8 rounded-md text-emerald-400 hover:text-emerald-300 hover:bg-emerald-950/30 disabled:opacity-50 cursor-pointer"
                  aria-label="Save & Close"
                >
                  {isSaving ? <Loader2 className="size-4 animate-spin" /> : <Check className="size-4" />}
                </Button>
              </TooltipTrigger>
              <TooltipContent side="bottom" className="text-xs">
                Save & Close <kbd className="ml-1 opacity-70">⌘S</kbd>
              </TooltipContent>
            </Tooltip>
          )}
          {onExtractText && (
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  variant="ghost"
                  size="icon"
                  onClick={onExtractText}
                  disabled={isExtracting}
                  className="size-8 rounded-md text-muted-foreground hover:text-foreground hover:bg-secondary disabled:opacity-50"
                  aria-label="Extract Text"
                >
                  {isExtracting ? <Loader2 className="size-4 animate-spin" /> : <FileText className="size-4" />}
                </Button>
              </TooltipTrigger>
              <TooltipContent side="bottom" className="text-xs">
                Extract Text (OCR)
              </TooltipContent>
            </Tooltip>
          )}
          {onDelete && (
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  variant="ghost"
                  size="icon"
                  onClick={onDelete}
                  className="size-8 rounded-md text-red-400 hover:text-red-300 hover:bg-red-950/30"
                  aria-label="Delete"
                >
                  <Trash2 className="size-4" />
                </Button>
              </TooltipTrigger>
              <TooltipContent side="bottom" className="text-xs">
                Delete
              </TooltipContent>
            </Tooltip>
          )}
        </div>
      </div>
    </TooltipProvider>
  );
});
