CREATE TABLE `agents` (
	`id` text PRIMARY KEY NOT NULL,
	`project_id` text NOT NULL,
	`name` text NOT NULL,
	`role` text DEFAULT 'operator' NOT NULL,
	`model` text NOT NULL,
	`mission` text DEFAULT '' NOT NULL,
	`autonomy` integer DEFAULT 1 NOT NULL,
	`heartbeat_minutes` integer DEFAULT 0 NOT NULL,
	`max_children` integer DEFAULT 0 NOT NULL,
	`allowlist_json` text DEFAULT '["Read","Grep","Glob"]' NOT NULL,
	`allowed_domains_json` text DEFAULT '[]' NOT NULL,
	`daily_cap_usd` real DEFAULT 2 NOT NULL,
	`max_turns` integer DEFAULT 30 NOT NULL,
	`billing` text DEFAULT 'subscription' NOT NULL,
	`status` text DEFAULT 'idle' NOT NULL,
	`claude_session_id` text,
	`last_run_at` integer,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	`archived_at` integer,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `agents_project_idx` ON `agents` (`project_id`);--> statement-breakpoint
CREATE INDEX `agents_status_idx` ON `agents` (`status`);--> statement-breakpoint
CREATE TABLE `events` (
	`id` text PRIMARY KEY NOT NULL,
	`agent_id` text,
	`project_id` text,
	`level` text DEFAULT 'info' NOT NULL,
	`message` text NOT NULL,
	`data_json` text,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL
);
--> statement-breakpoint
CREATE INDEX `events_created_idx` ON `events` (`created_at`);--> statement-breakpoint
CREATE INDEX `events_agent_idx` ON `events` (`agent_id`);--> statement-breakpoint
CREATE TABLE `fleet_state` (
	`id` integer PRIMARY KEY DEFAULT 1 NOT NULL,
	`killed` integer DEFAULT false NOT NULL,
	`killed_at` integer,
	`killed_reason` text,
	`updated_at` integer DEFAULT (unixepoch() * 1000) NOT NULL
);
--> statement-breakpoint
CREATE TABLE `gate_items` (
	`id` text PRIMARY KEY NOT NULL,
	`agent_id` text NOT NULL,
	`session_id` text,
	`loop_run_id` text,
	`kind` text NOT NULL,
	`label` text NOT NULL,
	`detail` text DEFAULT '' NOT NULL,
	`payload_json` text,
	`status` text DEFAULT 'pending' NOT NULL,
	`decided_by` text,
	`decision` text,
	`decided_at` integer,
	`executed_at` integer,
	`execution_result` text,
	`source` text DEFAULT 'permission-callback' NOT NULL,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	FOREIGN KEY (`agent_id`) REFERENCES `agents`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `gate_items_status_idx` ON `gate_items` (`status`);--> statement-breakpoint
CREATE INDEX `gate_items_agent_idx` ON `gate_items` (`agent_id`);--> statement-breakpoint
CREATE TABLE `loop_memory` (
	`loop_id` text NOT NULL,
	`key` text NOT NULL,
	`value_json` text NOT NULL,
	`updated_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	PRIMARY KEY(`loop_id`, `key`)
);
--> statement-breakpoint
CREATE TABLE `loop_runs` (
	`id` text PRIMARY KEY NOT NULL,
	`loop_id` text NOT NULL,
	`trigger_detail` text DEFAULT 'manual' NOT NULL,
	`started_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	`ended_at` integer,
	`outcome` text,
	`steps_trace_json` text DEFAULT '[]' NOT NULL,
	`scope_json` text DEFAULT '{}' NOT NULL,
	`resume_step_index` integer,
	`waiting_gate_id` text,
	`cost_usd` real DEFAULT 0 NOT NULL,
	FOREIGN KEY (`loop_id`) REFERENCES `loops`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `loop_runs_loop_idx` ON `loop_runs` (`loop_id`);--> statement-breakpoint
CREATE INDEX `loop_runs_started_idx` ON `loop_runs` (`started_at`);--> statement-breakpoint
CREATE TABLE `loops` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`file_path` text,
	`definition_json` text NOT NULL,
	`trigger_type` text NOT NULL,
	`status` text DEFAULT 'disabled' NOT NULL,
	`iterations_today` integer DEFAULT 0 NOT NULL,
	`iterations_date` text,
	`spend_today_usd` real DEFAULT 0 NOT NULL,
	`budget_per_run_usd` real NOT NULL,
	`budget_per_day_usd` real NOT NULL,
	`max_iterations_per_day` integer NOT NULL,
	`last_outcome` text,
	`last_run_at` integer,
	`parked_reason` text,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	`archived_at` integer
);
--> statement-breakpoint
CREATE UNIQUE INDEX `loops_name_unique` ON `loops` (`name`);--> statement-breakpoint
CREATE INDEX `loops_status_idx` ON `loops` (`status`);--> statement-breakpoint
CREATE TABLE `projects` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`path` text NOT NULL,
	`url` text,
	`tag` text,
	`sort_order` integer DEFAULT 0 NOT NULL,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	`archived_at` integer
);
--> statement-breakpoint
CREATE INDEX `projects_sort_order_idx` ON `projects` (`sort_order`);--> statement-breakpoint
CREATE TABLE `pulses` (
	`id` text PRIMARY KEY NOT NULL,
	`agent_id` text NOT NULL,
	`session_id` text,
	`window_start` integer NOT NULL,
	`window_end` integer NOT NULL,
	`finding` text NOT NULL,
	`clean` integer DEFAULT true NOT NULL,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	FOREIGN KEY (`agent_id`) REFERENCES `agents`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `pulses_agent_idx` ON `pulses` (`agent_id`);--> statement-breakpoint
CREATE INDEX `pulses_created_idx` ON `pulses` (`created_at`);--> statement-breakpoint
CREATE TABLE `sessions` (
	`id` text PRIMARY KEY NOT NULL,
	`agent_id` text NOT NULL,
	`claude_session_id` text,
	`started_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	`ended_at` integer,
	`exit_reason` text,
	`cost_usd` real DEFAULT 0 NOT NULL,
	`turns` integer DEFAULT 0 NOT NULL,
	`transcript_path` text,
	`trigger` text DEFAULT 'manual' NOT NULL,
	`archived_at` integer,
	FOREIGN KEY (`agent_id`) REFERENCES `agents`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `sessions_agent_idx` ON `sessions` (`agent_id`);--> statement-breakpoint
CREATE INDEX `sessions_started_idx` ON `sessions` (`started_at`);--> statement-breakpoint
CREATE TABLE `spend_daily` (
	`date` text NOT NULL,
	`agent_id` text NOT NULL,
	`cost_usd` real DEFAULT 0 NOT NULL,
	PRIMARY KEY(`date`, `agent_id`)
);
