import { useRef, useState } from 'react';
import { fetchProviderIcon, uploadProviderIcon } from '@/api/providerIcons';
import { ProviderBrandIcon } from '@/components/ProviderBrandIcon';
import { BrandGlyph, PROVIDER_BRANDS } from '@/components/providerBrands';
import { Button } from '@/components/ui/button';
import { FileInput } from '@/components/ui/file-input';
import { Input } from '@/components/ui/input';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Hint } from '@/components/ui/tooltip';

type Display = { provider?: string; base_url?: string | null; alias?: string };

/** 供应商图标弹层（I1）：选内置品牌、上传图片、按网址获取、恢复默认。只改表单里的值，保存时随 KEY 一起写。 */
export function ProviderIconPicker({ icon, display, defaultUrl, onChange }: {
  icon: string | null;
  display: Display;
  /** 按网址获取的默认地址（官网或接口地址的 origin）。 */
  defaultUrl: string;
  onChange: (icon: string | null) => void;
}) {
  const [open, setOpen] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [url, setUrl] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  const choose = (next: string | null) => {
    onChange(next);
    setError(null);
    setOpen(false);
  };
  const run = async (task: () => Promise<{ icon: string }>) => {
    setUploading(true);
    setError(null);
    try {
      choose((await task()).icon);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setUploading(false);
      if (fileRef.current) fileRef.current.value = '';
    }
  };
  const upload = (file: File | undefined) => file ? run(() => uploadProviderIcon(file)) : Promise.resolve();
  const address = (url ?? defaultUrl).trim();

  return (
    <Popover open={open} onOpenChange={next => { setOpen(next); if (!next) setError(null); }}>
      <PopoverTrigger asChild>
        <Button variant="ghost" size="icon" type="button" aria-label="更换图标"
          className="h-8 w-8 shrink-0 bg-secondary text-xs [&_svg]:size-5">
          <ProviderBrandIcon provider={{ ...display, icon }} />
        </Button>
      </PopoverTrigger>
      <PopoverContent align="start" className="w-80 p-3">
        <Tabs defaultValue={icon?.startsWith('file:') ? 'upload' : 'brand'}>
          <TabsList className="w-full">
            <TabsTrigger value="brand">品牌</TabsTrigger>
            <TabsTrigger value="upload">上传</TabsTrigger>
            <TabsTrigger value="url">网址</TabsTrigger>
          </TabsList>
          <TabsContent value="brand">
            <div className="grid grid-cols-7 gap-1">
              {PROVIDER_BRANDS.map(brand => {
                const value = `brand:${brand.id}`;
                return <Hint key={brand.id} label={brand.label}>
                  <Button variant="ghost" size="icon" type="button" aria-label={brand.label}
                    aria-pressed={icon === value} onClick={() => choose(value)}
                    className="text-muted-foreground hover:text-foreground aria-pressed:bg-secondary aria-pressed:text-foreground aria-pressed:ring-1 aria-pressed:ring-inset aria-pressed:ring-primary/60">
                    <BrandGlyph brand={brand.id} />
                  </Button>
                </Hint>;
              })}
            </div>
          </TabsContent>
          <TabsContent value="upload" className="space-y-2 py-1">
            <Button variant="outline" type="button" className="w-full" disabled={uploading} onClick={() => fileRef.current?.click()}>
              {uploading ? '上传中…' : '选择图片'}
            </Button>
            <FileInput ref={fileRef} aria-label="图标图片" accept="image/png,image/jpeg,image/webp,image/gif,image/x-icon,.ico"
              onChange={event => void upload(event.target.files?.[0])} />
            <p className="text-xs text-muted-foreground">PNG、JPEG、WebP、GIF、ICO，1 MB 以内</p>
          </TabsContent>
          <TabsContent value="url" className="space-y-2 py-1">
            <Input aria-label="图标网址" placeholder="https://" value={url ?? defaultUrl} onChange={event => setUrl(event.target.value)}
              onKeyDown={event => { if (event.key === 'Enter' && address && !uploading) { event.preventDefault(); void run(() => fetchProviderIcon(address)); } }} />
            <Button variant="outline" type="button" className="w-full" disabled={uploading || !address} onClick={() => void run(() => fetchProviderIcon(address))}>
              {uploading ? '获取中…' : '获取'}
            </Button>
          </TabsContent>
        </Tabs>
        {error && <p role="alert" className="mt-2 text-xs text-destructive">{error}</p>}
        <div className="mt-2 flex justify-end border-t border-border pt-2">
          <Button variant="ghost" size="sm" type="button" disabled={!icon} onClick={() => choose(null)}>恢复默认</Button>
        </div>
      </PopoverContent>
    </Popover>
  );
}
