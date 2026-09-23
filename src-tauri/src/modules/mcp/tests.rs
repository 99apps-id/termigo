mod tests {
    use super::client::env_for;
    use std::collections::HashMap;

    #[test]
    fn env_for_inherits_and_overrides() {
        std::env::set_var("TERMIGO_TEST_VAR", "inherited");
        let mut overrides = HashMap::new();
        overrides.insert("TERMIGO_TEST_VAR".to_string(), "override".to_string());
        overrides.insert("TERMIGO_NEW_VAR".to_string(), "new".to_string());

        let env = env_for(&overrides);
        assert_eq!(env.get("TERMIGO_TEST_VAR"), Some(&"override".to_string()));
        assert_eq!(env.get("TERMIGO_NEW_VAR"), Some(&"new".to_string()));
    }

    #[test]
    fn env_for_preserves_other_vars() {
        std::env::set_var("TERMIGO_OTHER_VAR", "other");
        let env = env_for(&HashMap::new());
        assert_eq!(env.get("TERMIGO_OTHER_VAR"), Some(&"other".to_string()));
    }
}
