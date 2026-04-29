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
          owner_user_id: string | null
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
          owner_user_id?: string | null
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
          owner_user_id?: string | null
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
        Relationships: [
          {
            foreignKeyName: 'codex_accounts_owner_user_id_fkey'
            columns: ['owner_user_id']
            isOneToOne: false
            referencedRelation: 'users'
            referencedColumns: ['id']
          },
        ]
      }
      codex_dashboard_share_invites: {
        Row: {
          id: string
          owner_user_id: string
          invite_token_hash: string
          invite_token_preview: string
          status: string
          expires_at: string
          accepted_by_user_id: string | null
          accepted_at: string | null
          created_at: string
          updated_at: string
        }
        Insert: {
          id?: string
          owner_user_id: string
          invite_token_hash: string
          invite_token_preview: string
          status?: string
          expires_at: string
          accepted_by_user_id?: string | null
          accepted_at?: string | null
          created_at?: string
          updated_at?: string
        }
        Update: {
          id?: string
          owner_user_id?: string
          invite_token_hash?: string
          invite_token_preview?: string
          status?: string
          expires_at?: string
          accepted_by_user_id?: string | null
          accepted_at?: string | null
          created_at?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: 'codex_dashboard_share_invites_accepted_by_user_id_fkey'
            columns: ['accepted_by_user_id']
            isOneToOne: false
            referencedRelation: 'users'
            referencedColumns: ['id']
          },
          {
            foreignKeyName: 'codex_dashboard_share_invites_owner_user_id_fkey'
            columns: ['owner_user_id']
            isOneToOne: false
            referencedRelation: 'users'
            referencedColumns: ['id']
          },
        ]
      }
      codex_dashboard_shares: {
        Row: {
          id: string
          owner_user_id: string
          viewer_user_id: string
          invite_id: string | null
          revoked_at: string | null
          created_at: string
          updated_at: string
        }
        Insert: {
          id?: string
          owner_user_id: string
          viewer_user_id: string
          invite_id?: string | null
          revoked_at?: string | null
          created_at?: string
          updated_at?: string
        }
        Update: {
          id?: string
          owner_user_id?: string
          viewer_user_id?: string
          invite_id?: string | null
          revoked_at?: string | null
          created_at?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: 'codex_dashboard_shares_invite_id_fkey'
            columns: ['invite_id']
            isOneToOne: false
            referencedRelation: 'codex_dashboard_share_invites'
            referencedColumns: ['id']
          },
          {
            foreignKeyName: 'codex_dashboard_shares_owner_user_id_fkey'
            columns: ['owner_user_id']
            isOneToOne: false
            referencedRelation: 'users'
            referencedColumns: ['id']
          },
          {
            foreignKeyName: 'codex_dashboard_shares_viewer_user_id_fkey'
            columns: ['viewer_user_id']
            isOneToOne: false
            referencedRelation: 'users'
            referencedColumns: ['id']
          },
        ]
      }
      codex_devices: {
        Row: {
          id: string
          owner_user_id: string
          pairing_session_id: string | null
          device_key: string
          device_token_hash: string
          label: string
          machine_name: string | null
          codex_home: string | null
          metadata: Json
          last_seen_at: string
          revoked_at: string | null
          created_at: string
          updated_at: string
        }
        Insert: {
          id?: string
          owner_user_id: string
          pairing_session_id?: string | null
          device_key: string
          device_token_hash: string
          label: string
          machine_name?: string | null
          codex_home?: string | null
          metadata?: Json
          last_seen_at?: string
          revoked_at?: string | null
          created_at?: string
          updated_at?: string
        }
        Update: {
          id?: string
          owner_user_id?: string
          pairing_session_id?: string | null
          device_key?: string
          device_token_hash?: string
          label?: string
          machine_name?: string | null
          codex_home?: string | null
          metadata?: Json
          last_seen_at?: string
          revoked_at?: string | null
          created_at?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: 'codex_devices_owner_user_id_fkey'
            columns: ['owner_user_id']
            isOneToOne: false
            referencedRelation: 'users'
            referencedColumns: ['id']
          },
          {
            foreignKeyName: 'codex_devices_pairing_session_id_fkey'
            columns: ['pairing_session_id']
            isOneToOne: false
            referencedRelation: 'codex_pairing_sessions'
            referencedColumns: ['id']
          },
        ]
      }
      codex_pairing_sessions: {
        Row: {
          id: string
          owner_user_id: string
          pair_token_hash: string
          pair_token_preview: string
          status: string
          expires_at: string
          paired_at: string | null
          last_seen_at: string | null
          created_at: string
          updated_at: string
        }
        Insert: {
          id?: string
          owner_user_id: string
          pair_token_hash: string
          pair_token_preview: string
          status?: string
          expires_at: string
          paired_at?: string | null
          last_seen_at?: string | null
          created_at?: string
          updated_at?: string
        }
        Update: {
          id?: string
          owner_user_id?: string
          pair_token_hash?: string
          pair_token_preview?: string
          status?: string
          expires_at?: string
          paired_at?: string | null
          last_seen_at?: string | null
          created_at?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: 'codex_pairing_sessions_owner_user_id_fkey'
            columns: ['owner_user_id']
            isOneToOne: false
            referencedRelation: 'users'
            referencedColumns: ['id']
          },
        ]
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
          owner_user_id: string | null
          access_scope: string
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
    Functions: {
      list_dashboard_inviters: {
        Args: Record<PropertyKey, never>
        Returns: {
          sharer_user_id: string
          sharer_email: string | null
          sharer_display_name: string | null
          sharer_avatar_url: string | null
          created_at: string
        }[]
      }
      list_dashboard_weekly_usage_history: {
        Args: {
          range_start: string
        }
        Returns: {
          fetched_at: string
          total_remaining_percent: number
          account_count: number
          total_capacity_percent: number
        }[]
      }
      user_can_access_codex_owner: {
        Args: {
          candidate_owner_user_id: string
        }
        Returns: boolean
      }
    }
    Enums: Record<string, never>
    CompositeTypes: Record<string, never>
  }
  auth: {
    Tables: {
      users: {
        Row: {
          id: string
        }
        Insert: {
          id: string
        }
        Update: {
          id?: string
        }
        Relationships: []
      }
    }
    Views: Record<string, never>
    Functions: Record<string, never>
    Enums: Record<string, never>
    CompositeTypes: Record<string, never>
  }
}
