package db

import (
	"database/sql"
	"errors"
	"fmt"
	"path/filepath"
	"regexp"
	"strings"
	"time"
)

type Project struct {
	ID         string
	Name       string
	Path       string
	CreatedAt  time.Time
	LastOpened *time.Time
}

var ErrNotFound = errors.New("not found")

// ListProjects returns all projects ordered by last_opened descending.
func ListProjects(db *sql.DB) ([]Project, error) {
	rows, err := db.Query(`SELECT id, name, path, created_at, last_opened FROM projects ORDER BY COALESCE(last_opened, created_at) DESC`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	var projects []Project
	for rows.Next() {
		var p Project
		var lastOpened sql.NullTime
		if err := rows.Scan(&p.ID, &p.Name, &p.Path, &p.CreatedAt, &lastOpened); err != nil {
			return nil, err
		}
		if lastOpened.Valid {
			p.LastOpened = &lastOpened.Time
		}
		projects = append(projects, p)
	}
	return projects, rows.Err()
}

// GetProject returns a project by ID, or ErrNotFound.
func GetProject(db *sql.DB, id string) (Project, error) {
	var p Project
	var lastOpened sql.NullTime
	err := db.QueryRow(`SELECT id, name, path, created_at, last_opened FROM projects WHERE id = ?`, id).
		Scan(&p.ID, &p.Name, &p.Path, &p.CreatedAt, &lastOpened)
	if errors.Is(err, sql.ErrNoRows) {
		return Project{}, ErrNotFound
	}
	if err != nil {
		return Project{}, err
	}
	if lastOpened.Valid {
		p.LastOpened = &lastOpened.Time
	}
	return p, nil
}

// CreateProject inserts a new project, generating a unique ID and name from the path.
func CreateProject(db *sql.DB, path string) (Project, error) {
	path = filepath.Clean(path)
	baseName := filepath.Base(path)

	// Generate unique name and ID
	name, err := uniqueProjectName(db, baseName)
	if err != nil {
		return Project{}, err
	}
	id, err := uniqueProjectID(db, slugify(baseName))
	if err != nil {
		return Project{}, err
	}

	now := time.Now().UTC()
	_, err = db.Exec(
		`INSERT INTO projects (id, name, path, created_at) VALUES (?, ?, ?, ?)`,
		id, name, path, now,
	)
	if err != nil {
		return Project{}, fmt.Errorf("insert project: %w", err)
	}

	return Project{ID: id, Name: name, Path: path, CreatedAt: now}, nil
}

// DeleteProject removes a project by ID.
func DeleteProject(db *sql.DB, id string) error {
	res, err := db.Exec(`DELETE FROM projects WHERE id = ?`, id)
	if err != nil {
		return err
	}
	n, _ := res.RowsAffected()
	if n == 0 {
		return ErrNotFound
	}
	return nil
}

// TouchProject updates last_opened for the given project ID.
func TouchProject(db *sql.DB, id string) error {
	_, err := db.Exec(`UPDATE projects SET last_opened = ? WHERE id = ?`, time.Now().UTC(), id)
	return err
}

// slugify converts a name to a lowercase slug with only alphanumeric and hyphens.
var nonAlphanumRe = regexp.MustCompile(`[^a-z0-9]+`)

func slugify(s string) string {
	s = strings.ToLower(s)
	s = nonAlphanumRe.ReplaceAllString(s, "-")
	s = strings.Trim(s, "-")
	if s == "" {
		s = "project"
	}
	return s
}

func uniqueProjectName(db *sql.DB, base string) (string, error) {
	name := base
	for i := 2; ; i++ {
		var count int
		if err := db.QueryRow(`SELECT COUNT(*) FROM projects WHERE name = ?`, name).Scan(&count); err != nil {
			return "", err
		}
		if count == 0 {
			return name, nil
		}
		name = fmt.Sprintf("%s (%d)", base, i)
	}
}

func uniqueProjectID(db *sql.DB, base string) (string, error) {
	id := base
	for i := 2; ; i++ {
		var count int
		if err := db.QueryRow(`SELECT COUNT(*) FROM projects WHERE id = ?`, id).Scan(&count); err != nil {
			return "", err
		}
		if count == 0 {
			return id, nil
		}
		id = fmt.Sprintf("%s%d", base, i)
	}
}
