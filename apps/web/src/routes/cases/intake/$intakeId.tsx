import { createFileRoute, Link } from '@tanstack/react-router';
export const Route = createFileRoute('/cases/intake/$intakeId')({
  component: RetiredIntake,
});
function RetiredIntake() {
  return (
    <section className="space-y-4 rounded-xl border bg-card p-6">
      <h1 className="text-xl font-semibold">收件功能已停用</h1>
      <p className="text-sm text-muted-foreground">
        所有新案件請由後台單筆或批量建檔。既有歷史資料仍保留，不再接受收件或圖片辨識。
      </p>
      <Link
        to="/cases"
        search={{ page: 1, query: '' }}
        className="text-primary"
      >
        前往案件管理
      </Link>
    </section>
  );
}
