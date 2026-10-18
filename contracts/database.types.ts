/**
 * Hand-maintained subset of database types for server work.
 * Full codegen can replace this later (`supabase gen types`).
 * G1 additions: allowed_teachers, extended question_type, RPC stubs.
 */

export type UserRole = "teacher" | "student";
export type AssessmentStatus = "draft" | "published" | "archived";
export type AssessmentMode = "practice" | "graded";
export type QuestionType =
  | "numeric"
  | "short_answer"
  | "single_choice"
  | "multiple_choice"
  | "true_false"
  | "ordering"
  | "matching";
export type AttemptStatus = "in_progress" | "completed" | "abandoned";

export interface Database {
  public: {
    Tables: {
      profiles: {
        Row: {
          id: string;
          role: UserRole;
          full_name: string;
          generated_nickname: string;
          student_login_code: string | null;
          created_at: string;
        };
        Insert: {
          id: string;
          role: UserRole;
          full_name: string;
          generated_nickname: string;
          student_login_code?: string | null;
          created_at?: string;
        };
        Update: Partial<Database["public"]["Tables"]["profiles"]["Insert"]>;
      };
      schools: {
        Row: { id: string; name: string; created_at: string };
        Insert: { id?: string; name: string; created_at?: string };
        Update: Partial<Database["public"]["Tables"]["schools"]["Insert"]>;
      };
      classes: {
        Row: { id: string; school_id: string; name: string; created_at: string };
        Insert: { id?: string; school_id: string; name: string; created_at?: string };
        Update: Partial<Database["public"]["Tables"]["classes"]["Insert"]>;
      };
      class_teachers: {
        Row: { class_id: string; teacher_id: string };
        Insert: { class_id: string; teacher_id: string };
        Update: Partial<Database["public"]["Tables"]["class_teachers"]["Insert"]>;
      };
      class_students: {
        Row: { student_id: string; class_id: string };
        Insert: { student_id: string; class_id: string };
        Update: Partial<Database["public"]["Tables"]["class_students"]["Insert"]>;
      };
      assessment_templates: {
        Row: {
          id: string;
          teacher_id: string;
          subject_id: string;
          grade_level: number;
          title: string;
          description: string;
          mode: AssessmentMode;
          status: AssessmentStatus;
          settings: Record<string, unknown>;
          created_at: string;
          updated_at: string;
        };
      };
      assessment_questions: {
        Row: {
          id: string;
          template_id: string;
          position: number;
          question_type: QuestionType;
          prompt: Record<string, unknown>;
          choices: unknown[];
          points: number;
          time_limit_seconds: number | null;
          created_at: string;
        };
      };
      assessment_attempts: {
        Row: {
          id: string;
          assignment_id: string;
          student_id: string;
          status: AttemptStatus;
          started_at: string;
          finished_at: string | null;
          score: number | null;
          max_score: number | null;
          passed: boolean | null;
          elapsed_ms: number | null;
          created_at: string;
        };
      };
    };
  };
  private: {
    Tables: {
      allowed_teachers: {
        Row: { email: string; note: string; created_at: string };
        Insert: { email: string; note?: string; created_at?: string };
        Update: Partial<Database["private"]["Tables"]["allowed_teachers"]["Insert"]>;
      };
      assessment_answer_keys: {
        Row: {
          question_id: string;
          answer_key: Record<string, unknown>;
          checker_version: number;
        };
      };
    };
  };
}
