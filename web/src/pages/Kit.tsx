import { useRef, useState, type ReactNode } from 'react';

import { MetaTag } from '@/components/MetaTag';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Checkbox } from '@/components/ui/checkbox';
import { RadioGroup, RadioGroupItem } from '@/components/ui/radio-group';
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle, DialogTrigger } from '@/components/ui/dialog';
import { FileInput } from '@/components/ui/file-input';
import { Input } from '@/components/ui/input';
import { SecretInput } from '@/components/ui/secret-input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Slider } from '@/components/ui/slider';
import { Switch } from '@/components/ui/switch';
import { Textarea } from '@/components/ui/textarea';
import { Label } from '@/components/ui/label';

const BUTTON_VARIANTS = ['default', 'secondary', 'outline', 'ghost', 'destructive', 'link'] as const;
const BUTTON_SIZES = ['sm', 'default', 'lg'] as const;

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="space-y-4">
      <h2 className="text-xs text-muted-foreground">{title}</h2>
      {children}
    </section>
  );
}

function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="grid grid-cols-1 items-center gap-2 sm:grid-cols-[120px_minmax(0,1fr)] sm:gap-4">
      <span className="text-xs text-muted-foreground">{label}</span>
      <div className="flex min-w-0 flex-wrap items-center gap-3">{children}</div>
    </div>
  );
}

/** 开发期组件样例页（/kit）：新页面先对照这里，缺什么先补进 components/ui。 */
export function Kit() {
  const [revealed, setRevealed] = useState(false);
  const [enabled, setEnabled] = useState(true);
  const [size, setSize] = useState(40);
  const [radio, setRadio] = useState('a');
  const file = useRef<HTMLInputElement>(null);

  return (
    <div className="mx-auto max-w-3xl space-y-8 p-6">
      <h1 className="font-display text-display">Kit</h1>

      <Section title="按钮">
        {BUTTON_SIZES.map(sizeName => (
          <Row key={sizeName} label={`size=${sizeName}`}>
            {BUTTON_VARIANTS.map(variant => <Button key={variant} variant={variant} size={sizeName}>{variant}</Button>)}
          </Row>
        ))}
      </Section>

      <Section title="输入">
        <Row label="Input"><Input placeholder="名称" /></Row>
        <Row label="SecretInput">
          <SecretInput className="flex-1" revealed={revealed} placeholder="粘贴密钥" />
          <Button variant="outline" size="sm" onClick={() => setRevealed(!revealed)}>{revealed ? '隐藏' : '显示'}</Button>
        </Row>
        <Row label="Textarea"><Textarea placeholder="提示词" /></Row>
        <Row label="Select">
          <Select defaultValue="b">
            <SelectTrigger aria-label="样例下拉"><SelectValue /></SelectTrigger>
            <SelectContent><SelectItem value="a">选项 A</SelectItem><SelectItem value="b">选项 B</SelectItem></SelectContent>
          </Select>
        </Row>
        <Row label="Checkbox / Radio">
          <Label className="flex items-center gap-2 text-sm"><Checkbox defaultChecked />多选</Label>
          <RadioGroup className="flex" value={radio} onValueChange={setRadio}>
            {['a', 'b'].map(value => (
              <Label key={value} className="flex items-center gap-2 text-sm">
                <RadioGroupItem value={value} />单选 {value.toUpperCase()}
              </Label>
            ))}
          </RadioGroup>
        </Row>
        <Row label="Switch"><Switch checked={enabled} aria-label="启用" onCheckedChange={setEnabled} /></Row>
        <Row label="Slider">
          <Slider className="flex-1" aria-label="样例滑杆" min={0} max={100} value={[size]} onValueChange={([next]) => setSize(next)} />
          <span className="text-sm tabular-nums">{size}</span>
        </Row>
        <Row label="FileInput">
          <FileInput ref={file} />
          <Button variant="secondary" onClick={() => file.current?.click()}>选择文件</Button>
        </Row>
      </Section>

      <Section title="标签">
        <Row label="Badge">
          {(['default', 'secondary', 'outline', 'success', 'warning', 'destructive'] as const).map(variant => <Badge key={variant} variant={variant}>{variant}</Badge>)}
        </Row>
        <Row label="MetaTag"><MetaTag>1024×1024</MetaTag><MetaTag>20s</MetaTag></Row>
      </Section>

      <Section title="表面">
        <Card className="p-5 text-sm">卡片 bg-card</Card>
        <Dialog>
          <DialogTrigger asChild><Button variant="outline">打开弹窗</Button></DialogTrigger>
          <DialogContent>
            <DialogHeader><DialogTitle>弹窗标题</DialogTitle></DialogHeader>
            <Input placeholder="弹窗内输入" />
            <DialogFooter><Button>确定</Button></DialogFooter>
          </DialogContent>
        </Dialog>
      </Section>
    </div>
  );
}
