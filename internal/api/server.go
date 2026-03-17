//go:generate go tool oapi-codegen -config config.yaml ../../api/openapi.yaml

package api

import (
	"braces.dev/errtrace"
	"encoding/json"
	"net/http"
)

// WriteJSON writes a JSON response
func WriteJSON(w http.ResponseWriter, status int, data interface{}) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	json.NewEncoder(w).Encode(data)
}

// WriteError writes a JSON error response.
func WriteError(w http.ResponseWriter, status int, message string) {
	WriteJSON(w, status, ErrorResponse{
		Code:  status,
		Error: ErrorResponseError(message),
	})
}

// WriteErrorDetails writes a JSON error response with a details string.
func WriteErrorDetails(w http.ResponseWriter, status int, message, details string) {
	WriteJSON(w, status, ErrorResponse{
		Code:    status,
		Error:   ErrorResponseError(message),
		Details: details,
	})
}

// ReadJSON reads JSON from a request body
func ReadJSON(r *http.Request, v interface{}) error {
	return errtrace.Wrap(json.NewDecoder(r.Body).Decode(v))
}
