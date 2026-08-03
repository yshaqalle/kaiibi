-- Add support for non-contiguous date ranges in time off requests
-- Each request can now specify multiple date ranges (e.g., work Mon/Wed, off Tue/Thu)

ALTER TABLE time_off_requests 
ADD COLUMN date_ranges JSONB DEFAULT '[]'::jsonb;

-- Migrate existing startDate/endDate to date_ranges
UPDATE time_off_requests 
SET date_ranges = jsonb_build_array(
  jsonb_build_object(
    'startDate', start_date,
    'endDate', end_date
  )
)
WHERE start_date IS NOT NULL AND end_date IS NOT NULL;

-- Add index for better query performance on date_ranges
CREATE INDEX idx_time_off_requests_date_ranges 
ON time_off_requests USING GIN (date_ranges);

-- Comment documenting the new column format
COMMENT ON COLUMN time_off_requests.date_ranges IS 
'Array of date ranges: [{startDate: "YYYY-MM-DD", endDate: "YYYY-MM-DD"}, ...]';
