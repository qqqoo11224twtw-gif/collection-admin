import {
  Alert,
  AlertDescription,
  AlertTitle,
} from '@saasflare-dev/ui/components/alert';
import { Badge } from '@saasflare-dev/ui/components/badge';
import { Button } from '@saasflare-dev/ui/components/button';
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@saasflare-dev/ui/components/card';
import { Checkbox } from '@saasflare-dev/ui/components/checkbox';
import { Input } from '@saasflare-dev/ui/components/input';
import { Label } from '@saasflare-dev/ui/components/label';
import { Progress } from '@saasflare-dev/ui/components/progress';
import { Skeleton } from '@saasflare-dev/ui/components/skeleton';
import { Textarea } from '@saasflare-dev/ui/components/textarea';
import { createFileRoute } from '@tanstack/react-router';
import { Info, Loader2, TriangleAlert } from 'lucide-react';
import type { ReactNode } from 'react';

export const Route = createFileRoute('/design/components')({
  component: ComponentsPage,
});

function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex flex-col gap-2 border-b border-border last:border-0 px-4 py-3 sm:flex-row sm:items-center sm:gap-6">
      <code className="text-xs text-muted-foreground w-32 shrink-0">
        {label}
      </code>
      <div className="flex flex-wrap items-center gap-2">{children}</div>
    </div>
  );
}

function Block({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="flex flex-col gap-3">
      <h2 className="text-lg font-semibold tracking-tight">{title}</h2>
      <div className="rounded-lg border border-border bg-card">{children}</div>
    </section>
  );
}

function ComponentsPage() {
  return (
    <div className="flex flex-col gap-10">
      <p className="text-sm text-muted-foreground max-w-2xl">
        Every variant rendered at once, so a component update shows its damage
        here before it reaches a product screen. Hover and focus states are not
        capturable in a screenshot — check those live.
      </p>

      <Block title="Button">
        <Row label="variant">
          <Button>Default</Button>
          <Button variant="secondary">Secondary</Button>
          <Button variant="outline">Outline</Button>
          <Button variant="ghost">Ghost</Button>
          <Button variant="link">Link</Button>
          <Button variant="destructive">Destructive</Button>
        </Row>
        <Row label="size">
          <Button size="xs">xs</Button>
          <Button size="sm">sm</Button>
          <Button size="default">default</Button>
          <Button size="lg">lg</Button>
        </Row>
        <Row label="state">
          <Button disabled>Disabled</Button>
          <Button variant="outline" disabled>
            Disabled outline
          </Button>
          <Button disabled>
            <Loader2 className="animate-spin" />
            Loading
          </Button>
        </Row>
      </Block>

      <Block title="Badge">
        <Row label="variant">
          <Badge>Default</Badge>
          <Badge variant="secondary">Secondary</Badge>
          <Badge variant="outline">Outline</Badge>
          <Badge variant="destructive">Destructive</Badge>
        </Row>
      </Block>

      <Block title="Form controls">
        <Row label="input">
          <Input className="w-56" placeholder="you@example.com" />
          <Input className="w-40" defaultValue="Filled" />
        </Row>
        <Row label="input state">
          <Input className="w-40" placeholder="Disabled" disabled />
          <Input className="w-40" aria-invalid defaultValue="Invalid" />
        </Row>
        <Row label="textarea">
          <Textarea className="w-72" placeholder="Describe the issue…" />
        </Row>
        <Row label="checkbox">
          <span className="flex items-center gap-2">
            <Checkbox id="c1" defaultChecked />
            <Label htmlFor="c1">Checked</Label>
          </span>
          <span className="flex items-center gap-2">
            <Checkbox id="c2" />
            <Label htmlFor="c2">Unchecked</Label>
          </span>
          <span className="flex items-center gap-2">
            <Checkbox id="c3" disabled />
            <Label htmlFor="c3">Disabled</Label>
          </span>
        </Row>
      </Block>

      <Block title="Feedback">
        <Row label="alert">
          <Alert className="max-w-md">
            <Info />
            <AlertTitle>Heads up</AlertTitle>
            <AlertDescription>
              Test mode charges are cleared every 30 days.
            </AlertDescription>
          </Alert>
        </Row>
        <Row label="alert destructive">
          <Alert variant="destructive" className="max-w-md">
            <TriangleAlert />
            <AlertTitle>Payout failed</AlertTitle>
            <AlertDescription>
              The connected bank account was closed.
            </AlertDescription>
          </Alert>
        </Row>
        <Row label="progress">
          <Progress value={64} className="w-56" />
        </Row>
        <Row label="skeleton">
          <div className="flex flex-col gap-2">
            <Skeleton className="h-4 w-48" />
            <Skeleton className="h-4 w-32" />
          </div>
        </Row>
      </Block>

      <Block title="Card">
        <Row label="default">
          <Card className="w-72">
            <CardHeader>
              <CardTitle>Monthly volume</CardTitle>
              <CardDescription>Across all payment methods</CardDescription>
            </CardHeader>
            <CardContent>
              <span className="text-2xl font-semibold tabular-nums">
                24,318.00
              </span>
            </CardContent>
          </Card>
        </Row>
        <Row label="size=sm">
          <Card className="w-72" data-size="sm">
            <CardHeader>
              <CardTitle>Monthly volume</CardTitle>
              <CardDescription>Same card, denser spacing</CardDescription>
            </CardHeader>
            <CardContent>
              <span className="text-2xl font-semibold tabular-nums">
                24,318.00
              </span>
            </CardContent>
          </Card>
        </Row>
      </Block>
    </div>
  );
}
