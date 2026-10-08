-- Custom SQL migration file, put your code below! --
-- Add validation without rebuilding cases or its referenced history tables.
CREATE TRIGGER cases_region_insert BEFORE INSERT ON cases
WHEN NEW.region IS NOT NULL AND NEW.region NOT IN ('基隆市','台北市','新北市','桃園市','新竹市','新竹縣','苗栗縣','台中市','彰化縣','南投縣','雲林縣','嘉義市','嘉義縣','台南市','高雄市','屏東縣','宜蘭縣','花蓮縣','台東縣','澎湖縣','金門縣','連江縣')
BEGIN SELECT RAISE(ABORT,'INVALID_REGION'); END;
--> statement-breakpoint
CREATE TRIGGER cases_region_update BEFORE UPDATE OF region ON cases
WHEN NEW.region IS NOT NULL AND NEW.region NOT IN ('基隆市','台北市','新北市','桃園市','新竹市','新竹縣','苗栗縣','台中市','彰化縣','南投縣','雲林縣','嘉義市','嘉義縣','台南市','高雄市','屏東縣','宜蘭縣','花蓮縣','台東縣','澎湖縣','金門縣','連江縣')
BEGIN SELECT RAISE(ABORT,'INVALID_REGION'); END;
--> statement-breakpoint
CREATE TRIGGER assignment_correction_insert BEFORE INSERT ON assignments
WHEN NEW.record_type NOT IN ('assignment','correction') OR (NEW.record_type='correction' AND (NEW.corrected_from_id IS NULL OR NEW.correction_reason IS NULL OR length(trim(NEW.correction_reason))=0 OR NOT EXISTS(SELECT 1 FROM assignments a WHERE a.id=NEW.corrected_from_id AND a.case_id=NEW.case_id)))
BEGIN SELECT RAISE(ABORT,'INVALID_CORRECTION'); END;
