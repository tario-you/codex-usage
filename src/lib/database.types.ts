export type Json =
  | string
  | number
  | boolean
  | null
  | { [key: string]: Json | undefined }
  | Json[]

export interface Database {
  public: {
    Tables: {
      codex_accounts: {
        Row: {
          id: string
          account_key: string
          email: string | null
          plan_type: string | null
          display_name: string | null
          source_key: string
          source_label: string | null
          codex_home: string | null
          metadata: Json
          last_seen_at: string
          last_snapshot_at: string | null
          created_at: string
          updated_at: string
        }
        Insert: {
          id?: string
          account_key: string
          email?: string | null
          plan_type?: string | null
          display_name?: string | null
          source_key: string
          source_label?: string | null
          codex_home?: string | null
          metadata?: Json
          last_seen_at?: string
          last_snapshot_at?: string | null
          created_at?: string
          updated_at?: string
        }
        Update: {
          id?: string
          account_key?: string
          email?: string | null
          plan_type?: string | null
          display_name?: string | null
          source_key?: string
          source_label?: string | null
          codex_home?: string | null
          metadata?: Json
          last_seen_at?: string
          last_snapshot_at?: string | null
          created_at?: string
          updated_at?: string
        }
        Relationships: []
      }
      codex_usage_snapshots: {
        Row: {
          id: number
          account_id: string
          source_key: string
          fetched_at: string
          primary_used_percent: number | null
          primary_window_mins: number | null
          primary_resets_at: string | null
          secondary_used_percent: number | null
          secondary_window_mins: number | null
          secondary_resets_at: string | null
          credits_balance: number | null
          has_credits: boolean | null
          unlimited_credits: boolean | null
          raw_rate_limits: Json
          raw_rate_limits_by_limit_id: Json
        }
        Insert: {
          id?: never
          account_id: string
          source_key: string
          fetched_at?: string
          primary_used_percent?: number | null
          primary_window_mins?: number | null
          primary_resets_at?: string | null
          secondary_used_percent?: number | null
          secondary_window_mins?: number | null
          secondary_resets_at?: string | null
          credits_balance?: number | null
          has_credits?: boolean | null
          unlimited_credits?: boolean | null
          raw_rate_limits: Json
          raw_rate_limits_by_limit_id?: Json
        }
        Update: {
          id?: never
          account_id?: string
          source_key?: string
          fetched_at?: string
          primary_used_percent?: number | null
          primary_window_mins?: number | null
          primary_resets_at?: string | null
          secondary_used_percent?: number | null
          secondary_window_mins?: number | null
          secondary_resets_at?: string | null
          credits_balance?: number | null
          has_credits?: boolean | null
          unlimited_credits?: boolean | null
          raw_rate_limits?: Json
          raw_rate_limits_by_limit_id?: Json
        }
        Relationships: [
          {
            foreignKeyName: 'codex_usage_snapshots_account_id_fkey'
            columns: ['account_id']
            isOneToOne: false
            referencedRelation: 'codex_accounts'
            referencedColumns: ['id']
          },
        ]
      }
    }
    Views: {
      codex_dashboard_accounts: {
        Row: {
          id: string
          account_key: string
          email: string | null
          label: string | null
          plan_type: string | null
          source_key: string
          source_label: string | null
          codex_home: string | null
          metadata: Json
          last_seen_at: string
          last_snapshot_at: string | null
          snapshot_id: number | null
          fetched_at: string | null
          primary_used_percent: number | null
          primary_remaining_percent: number | null
          primary_window_mins: number | null
          primary_resets_at: string | null
          secondary_used_percent: number | null
          secondary_remaining_percent: number | null
          secondary_window_mins: number | null
          secondary_resets_at: string | null
          credits_balance: number | null
          has_credits: boolean | null
          unlimited_credits: boolean | null
          raw_rate_limits: Json | null
          raw_rate_limits_by_limit_id: Json | null
        }
        Relationships: []
      }
    }
    Functions: Record<string, never>
    Enums: Record<string, never>
    CompositeTypes: Record<string, never>
  }
}
