/** Hand-maintained subset for server work (G1). */
export type UserRole = "teacher" | "student";
export type AssessmentStatus = "draft" | "published" | "archived";
export type AssessmentMode = "practice" | "graded";
export type QuestionType =
  | "numeric" | "short_answer" | "single_choice" | "multiple_choice"
  | "true_false" | "ordering" | "matching";
export type AttemptStatus = "in_progress" | "completed" | "abandoned";

export interface Database {
  public: {
    Tables: {
      profiles: {
        Row: {
          id: string; role: UserRole; full_name: string;
          generated_nickname: string; student_login_code: string | null; created_at: string;
        };
        Insert: {
          id: string; role: UserRole; full_name: string;
          generated_nickname: string; student_login_code?: string | null; created_at?: string;
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
    };
    Functions: {
      api_is_allowed_teacher: { Args: { p_email: string }; Returns: boolean };
      api_provision_teacher: {
        Args: { p_user_id: string; p_full_name: string; p_school_name: string; p_class_name: string };
        Returns: { profileId: string; schoolId: string; classId: string; created: boolean };
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
    };
  };
}
