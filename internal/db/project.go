package db

import (
	"braces.dev/errtrace"
	"gorm.io/gorm"
)

// Project is a stable, machine-local catalogue entry. ID is used for the
// project's state directory while Name is the user-facing label.
type Project struct {
	ID       string `gorm:"primaryKey"`
	Path     string `gorm:"not null;uniqueIndex"`
	Name     string `gorm:"not null"`
	Builtin  bool   `gorm:"not null"`
	Hidden   bool   `gorm:"not null"`
	Position int    `gorm:"not null;index"`
}

func (s *Store) ListProjects() ([]Project, error) {
	var projects []Project
	if err := s.reader().Order("position ASC, id ASC").Find(&projects).Error; err != nil {
		return nil, errtrace.Wrap(err)
	}
	return projects, nil
}

// ReplaceProjects atomically persists the complete ordered catalogue.
func (s *Store) ReplaceProjects(projects []Project) error {
	return errtrace.Wrap(s.db.Transaction(func(tx *gorm.DB) error {
		if err := tx.Session(&gorm.Session{AllowGlobalUpdate: true}).Delete(&Project{}).Error; err != nil {
			return err
		}
		if len(projects) == 0 {
			return nil
		}
		return tx.Create(&projects).Error
	}))
}

// ClearAgents removes the machine head catalogue while retaining runtime-wide
// metadata such as registered projects.
func (s *Store) ClearAgents() error {
	return errtrace.Wrap(s.db.Unscoped().Session(&gorm.Session{AllowGlobalUpdate: true}).Delete(&Agent{}).Error)
}
