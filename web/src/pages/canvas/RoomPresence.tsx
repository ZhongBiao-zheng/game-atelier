import { ViewportPortal } from '@xyflow/react';
import { AnimatePresence, motion } from 'motion/react';
import type { CanvasDocument } from '@/schema/canvas';
import { canvasNodeRenderedSize } from '../canvasEditorModel';
import { Hint } from '@/components/ui/tooltip';
import { MOTION_DURATION, MOTION_EASE, MOTION_SPRING } from '@/lib/motion';
import type { RoomMember } from './useCollabRoom';

const colors = ['var(--primary)', 'var(--brand-2)', 'var(--brand-3)', 'var(--brand-4)', 'var(--chart-1)', 'var(--chart-5)'];
/** 头像进出淡变，其余头像与顶栏按钮用 snappy 让位，顶栏宽度不跳。 */
const AVATAR_MOTION = {
  layout: true, initial: { opacity: 0 }, animate: { opacity: 1 },
  exit: { opacity: 0, transition: { duration: MOTION_DURATION.fast, ease: MOTION_EASE.subtle } },
  transition: { layout: MOTION_SPRING.snappy, opacity: { duration: MOTION_DURATION.fast, ease: MOTION_EASE.subtle } },
} as const;

export function memberColor(member: RoomMember) {
  return colors[member.color_index % colors.length] || colors[0];
}

export function RoomPresence({members}: {members: RoomMember[]}) {
  return <AnimatePresence initial={false}>{members.length > 0 && <motion.span key="presence" {...AVATAR_MOTION} className="inline-flex">
    <Hint label={members.map(person => person.display_name + (person.role === 'owner' ? '（房主）' : '（协作者）')).join('、')}>
      <span tabIndex={0} aria-label={'在线成员：' + members.map(member => member.display_name).join('、')}
        className="inline-flex items-center gap-1 px-1 text-xs">
        <AnimatePresence initial={false} mode="popLayout">
          {members.slice(0,4).map(member => <motion.span key={member.client_id} {...AVATAR_MOTION}
            className="grid size-6 place-items-center rounded-full border bg-card"
            style={{borderColor:memberColor(member)}}>{Array.from(member.display_name)[0]}</motion.span>)}
          {members.length > 4 && <motion.span key="more" {...AVATAR_MOTION} className="tabular-nums">+{members.length-4}</motion.span>}
        </AnimatePresence>
      </span>
    </Hint>
  </motion.span>}</AnimatePresence>;
}

export function RoomSelectionOverlay({members,document}:{members:RoomMember[]; document:CanvasDocument}) {
  if (!members.length) return null;
  return <ViewportPortal>{members.flatMap(member=>member.selected_node_ids.flatMap(id=>{
    const node = document.nodes.find(item=>item.id === id);
    if (!node) return [];
    const point = member.positions[id] ?? node.position;
    return [<div key={member.client_id+id} className="pointer-events-none absolute z-50 rounded-lg border-2"
      style={{left:point.x,top:point.y,...canvasNodeRenderedSize(node,document.content_versions),borderColor:memberColor(member)}}>
      <span className="absolute bottom-full right-0 rounded bg-card px-1 text-xs" style={{color:memberColor(member)}}>{member.display_name}</span>
    </div>];
  }))}</ViewportPortal>;
}
