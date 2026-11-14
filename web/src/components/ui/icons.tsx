/**
 * 全站图标唯一入口（DESIGN.md「图标」）。页面只从这里导入语义图标，不直接用图标库。
 * 图标库：Hugeicons Rounded Stroke（免费 MIT）。一个含义只对应一个图标；新增图标先在这里登记。
 */
import { forwardRef, type ForwardRefExoticComponent, type RefAttributes, type SVGProps } from 'react';
import { HugeiconsIcon, type IconSvgElement } from '@hugeicons/react';
import * as Huge from '@hugeicons/core-free-icons';

/** 尺寸四档：sm 芯片与标签内联 / md 按钮、菜单、列表（默认）/ lg 顶栏与悬浮工具条 / xl 空状态与占位 */
export const ICON_PX = { sm: 14, md: 16, lg: 18, xl: 24 } as const;
export type IconSize = keyof typeof ICON_PX;
/** 描边固定 1.5；14px 下 1.5 只剩 0.875 物理像素，补到 1.75。 */
const STROKE: Record<IconSize, number> = { sm: 1.75, md: 1.5, lg: 1.5, xl: 1.5 };

export interface IconProps extends Omit<SVGProps<SVGSVGElement>, 'ref' | 'width' | 'height' | 'strokeWidth'> {
  size?: IconSize;
}
export type AppIcon = ForwardRefExoticComponent<IconProps & RefAttributes<SVGSVGElement>>;

const GLYPHS = new WeakMap<AppIcon, IconSvgElement>();
const kebab = (key: string) => key.replace(/[A-Z]/g, char => `-${char.toLowerCase()}`);

/** 命令式 DOM（contentEditable 芯片）用的 SVG 字符串，与组件同一份图形数据。 */
export function iconMarkup(icon: AppIcon, size: IconSize = 'md'): string {
  const glyph = GLYPHS.get(icon);
  if (!glyph) throw new Error('iconMarkup 只接受 ui/icons 登记的图标');
  const children = glyph.map(([tag, attrs]) => {
    const props = Object.entries(attrs).filter(([key]) => key !== 'key')
      .map(([key, value]) => `${kebab(key)}="${key === 'strokeWidth' ? STROKE[size] : value}"`).join(' ');
    return `<${tag} ${props}/>`;
  }).join('');
  const px = ICON_PX[size];
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" width="${px}" height="${px}" fill="none" aria-hidden="true">${children}</svg>`;
}

function defineIcon(glyph: IconSvgElement, name: string): AppIcon {
  const Icon = forwardRef<SVGSVGElement, IconProps>(({ size = 'md', ...props }, ref) => (
    <HugeiconsIcon
      ref={ref}
      icon={glyph}
      size={ICON_PX[size]}
      strokeWidth={STROKE[size]}
      data-icon={name}
      aria-hidden={props['aria-label'] ? undefined : true}
      {...props}
    />
  ));
  Icon.displayName = name;
  GLYPHS.set(Icon, glyph);
  return Icon;
}

export const AddIcon = defineIcon(Huge.Add01Icon, 'add');
export const AddImageIcon = defineIcon(Huge.ImageAdd01Icon, 'add-image');
export const AgentIcon = defineIcon(Huge.BotIcon, 'agent');
export const AiIcon = defineIcon(Huge.SparklesIcon, 'ai');
export const AngleIcon = defineIcon(Huge.ThreeDRotateIcon, 'angle');
export const ArchiveFileIcon = defineIcon(Huge.FileZipIcon, 'archive-file');
export const ArrowDownIcon = defineIcon(Huge.ArrowDown02Icon, 'arrow-down');
export const ArrowToolIcon = defineIcon(Huge.ArrowUpRight01Icon, 'arrow-tool');
export const ArrowUpIcon = defineIcon(Huge.ArrowUp02Icon, 'arrow-up');
export const AspectRatioIcon = defineIcon(Huge.SquareIcon, 'aspect-ratio');
export const AttachIcon = defineIcon(Huge.Attachment01Icon, 'attach');
export const AudioFileIcon = defineIcon(Huge.FileAudioIcon, 'audio-file');
export const AudioIcon = defineIcon(Huge.MusicNote01Icon, 'audio');
export const AutoModeIcon = defineIcon(Huge.FlashIcon, 'auto-mode');
export const AutoSizeIcon = defineIcon(Huge.CenterFocusIcon, 'auto-size');
export const BackIcon = defineIcon(Huge.ArrowLeft02Icon, 'back');
export const BlankIcon = defineIcon(Huge.SquareIcon, 'blank');
export const BookmarkIcon = defineIcon(Huge.Bookmark01Icon, 'bookmark');
export const BrushIcon = defineIcon(Huge.BrushIcon, 'brush');
export const CanvasIcon = defineIcon(Huge.PaletteIcon, 'canvas');
export const ChatIcon = defineIcon(Huge.BubbleChatIcon, 'chat');
export const CheckIcon = defineIcon(Huge.Tick02Icon, 'check');
export const ChevronDownIcon = defineIcon(Huge.ArrowDown01Icon, 'chevron-down');
export const ChevronLeftIcon = defineIcon(Huge.ArrowLeft01Icon, 'chevron-left');
export const ChevronRightIcon = defineIcon(Huge.ArrowRight01Icon, 'chevron-right');
export const ChevronUpIcon = defineIcon(Huge.ArrowUp01Icon, 'chevron-up');
export const CloseIcon = defineIcon(Huge.Cancel01Icon, 'close');
export const CollapseIcon = defineIcon(Huge.ArrowShrink01Icon, 'collapse');
export const CompareIcon = defineIcon(Huge.LayoutTwoColumnIcon, 'compare');
export const ConfirmModeIcon = defineIcon(Huge.SecurityCheckIcon, 'confirm-mode');
export const CopyIcon = defineIcon(Huge.Copy01Icon, 'copy');
export const CropIcon = defineIcon(Huge.CropIcon, 'crop');
export const CutIcon = defineIcon(Huge.ScissorsIcon, 'cut');
export const DarkModeIcon = defineIcon(Huge.Moon02Icon, 'dark-mode');
export const DeleteIcon = defineIcon(Huge.Delete02Icon, 'delete');
export const DotGridIcon = defineIcon(Huge.GripIcon, 'dot-grid');
export const DownloadIcon = defineIcon(Huge.Download01Icon, 'download');
export const DragHandleIcon = defineIcon(Huge.DragDropVerticalIcon, 'drag-handle');
export const EditIcon = defineIcon(Huge.PencilEdit02Icon, 'edit');
export const EraserIcon = defineIcon(Huge.EraserIcon, 'eraser');
export const ErrorIcon = defineIcon(Huge.AlertCircleIcon, 'error');
export const ExchangeIcon = defineIcon(Huge.ArrowDataTransferHorizontalIcon, 'exchange');
export const ExpandIcon = defineIcon(Huge.ArrowExpand01Icon, 'expand');
export const ExportFileIcon = defineIcon(Huge.FileExportIcon, 'export-file');
export const ExternalLinkIcon = defineIcon(Huge.LinkSquare02Icon, 'external-link');
export const FastForwardIcon = defineIcon(Huge.Forward01Icon, 'fast-forward');
export const FavoriteIcon = defineIcon(Huge.FavouriteIcon, 'favorite');
export const FitScreenIcon = defineIcon(Huge.FullScreenIcon, 'fit-screen');
export const FolderEditIcon = defineIcon(Huge.FolderEditIcon, 'folder-edit');
export const FolderIcon = defineIcon(Huge.Folder01Icon, 'folder');
export const FolderOffIcon = defineIcon(Huge.FolderOffIcon, 'folder-off');
export const FolderOpenIcon = defineIcon(Huge.FolderOpenIcon, 'folder-open');
export const GridIcon = defineIcon(Huge.GridTableIcon, 'grid');
export const HelpIcon = defineIcon(Huge.HelpCircleIcon, 'help');
export const HideIcon = defineIcon(Huge.ViewOffSlashIcon, 'hide');
export const HomeIcon = defineIcon(Huge.Home03Icon, 'home');
export const ImageFileIcon = defineIcon(Huge.FileImageIcon, 'image-file');
export const ImageIcon = defineIcon(Huge.Image01Icon, 'image');
export const ImagesIcon = defineIcon(Huge.Album02Icon, 'images');
export const InfoIcon = defineIcon(Huge.InformationCircleIcon, 'info');
export const KeyIcon = defineIcon(Huge.Key01Icon, 'key');
export const LayersIcon = defineIcon(Huge.Layers01Icon, 'layers');
export const LibraryIcon = defineIcon(Huge.LibraryIcon, 'library');
export const LightModeIcon = defineIcon(Huge.Sun03Icon, 'light-mode');
export const LinkIcon = defineIcon(Huge.Link04Icon, 'link');
export const LoadingIcon = defineIcon(Huge.LoaderCircleIcon, 'loading');
export const LockIcon = defineIcon(Huge.SquareLock02Icon, 'lock');
export const MinimapIcon = defineIcon(Huge.MapsIcon, 'minimap');
export const MinusIcon = defineIcon(Huge.MinusSignIcon, 'minus');
export const ModelIcon = defineIcon(Huge.CubeIcon, 'model');
export const MoreIcon = defineIcon(Huge.MoreHorizontalIcon, 'more');
export const MoveIcon = defineIcon(Huge.ArrowAllDirectionIcon, 'move');
export const MuteIcon = defineIcon(Huge.VolumeOffIcon, 'mute');
export const NewChatIcon = defineIcon(Huge.BubbleChatAddIcon, 'new-chat');
export const OutpaintIcon = defineIcon(Huge.ArrowExpandIcon, 'outpaint');
export const ParamsIcon = defineIcon(Huge.SlidersHorizontalIcon, 'params');
export const PauseIcon = defineIcon(Huge.PauseIcon, 'pause');
export const PenIcon = defineIcon(Huge.Pen01Icon, 'pen');
export const PlayIcon = defineIcon(Huge.PlayIcon, 'play');
export const ProviderIcon = defineIcon(Huge.Building03Icon, 'provider');
export const RectangleIcon = defineIcon(Huge.SquareIcon, 'rectangle');
export const RedoIcon = defineIcon(Huge.Redo02Icon, 'redo');
export const ReplaceFileIcon = defineIcon(Huge.FileUploadIcon, 'replace-file');
export const ResetIcon = defineIcon(Huge.UndoDotIcon, 'reset');
export const RetryIcon = defineIcon(Huge.Refresh04Icon, 'retry');
export const RewindIcon = defineIcon(Huge.Backward01Icon, 'rewind');
export const RouteIcon = defineIcon(Huge.Route01Icon, 'route');
export const SaveAssetIcon = defineIcon(Huge.BookmarkAdd01Icon, 'save-asset');
export const ScrollBottomIcon = defineIcon(Huge.ArrowDownDoubleIcon, 'scroll-bottom');
export const SearchIcon = defineIcon(Huge.Search01Icon, 'search');
export const SelectIcon = defineIcon(Huge.Cursor01Icon, 'select');
export const ServerIcon = defineIcon(Huge.ServerStack01Icon, 'server');
export const SettingsIcon = defineIcon(Huge.Settings02Icon, 'settings');
export const ShareIcon = defineIcon(Huge.Share08Icon, 'share');
export const ShowIcon = defineIcon(Huge.ViewIcon, 'show');
export const SkillIcon = defineIcon(Huge.PuzzleIcon, 'skill');
export const StarIcon = defineIcon(Huge.StarIcon, 'star');
export const StopIcon = defineIcon(Huge.StopIcon, 'stop');
export const TagIcon = defineIcon(Huge.Tag01Icon, 'tag');
export const TextFileIcon = defineIcon(Huge.FileTextIcon, 'text-file');
export const TextIcon = defineIcon(Huge.TextFontIcon, 'text');
export const ThinkingIcon = defineIcon(Huge.AiBrain01Icon, 'thinking');
export const ToolIcon = defineIcon(Huge.Wrench01Icon, 'tool');
export const UndoIcon = defineIcon(Huge.Undo02Icon, 'undo');
export const UnlockIcon = defineIcon(Huge.SquareUnlock02Icon, 'unlock');
export const UploadIcon = defineIcon(Huge.Upload01Icon, 'upload');
export const UpscaleIcon = defineIcon(Huge.HdIcon, 'upscale');
export const UsageIcon = defineIcon(Huge.Analytics01Icon, 'usage');
export const VideoFileIcon = defineIcon(Huge.FileVideoIcon, 'video-file');
export const VideoIcon = defineIcon(Huge.Video01Icon, 'video');
export const VolumeIcon = defineIcon(Huge.VolumeHighIcon, 'volume');
export const WarningIcon = defineIcon(Huge.Alert02Icon, 'warning');
export const WorkflowIcon = defineIcon(Huge.WorkflowSquare03Icon, 'workflow');

/** 产品内插件（设置页「插件」、缺失占位）的通用图标。 */
export const PluginIcon = defineIcon(Huge.Plug01Icon, 'plugin');
const PluginFramesIcon = defineIcon(Huge.KeyframesMultipleIcon, 'plugin-frames');
/** 插件清单 `icon` 字段可用的名字。插件不能自带图形，新名字先在这里登记。 */
const PLUGIN_ICONS: Record<string, AppIcon> = {
  frames: PluginFramesIcon, grid: GridIcon, cube: ModelIcon, layers: LayersIcon, scissors: CutIcon,
};
/** 未登记的名字回落到通用插件图标，旧版宿主遇到新名字不报错。 */
export function pluginIcon(name: string): AppIcon {
  return Object.hasOwn(PLUGIN_ICONS, name) ? PLUGIN_ICONS[name] : PluginIcon;
}
