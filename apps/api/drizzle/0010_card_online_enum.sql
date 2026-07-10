-- Custom SQL migration file, put your code below! --
ALTER TYPE payment_method RENAME TO payment_method_old;
--> statement-breakpoint
CREATE TYPE payment_method AS ENUM ('CASH', 'CARD_MACHINE', 'PIX_ONLINE', 'CARD_ONLINE');
--> statement-breakpoint
ALTER TABLE orders ALTER COLUMN payment_method TYPE payment_method USING payment_method::text::payment_method;
--> statement-breakpoint
DROP TYPE payment_method_old;
