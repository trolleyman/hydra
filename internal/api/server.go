//go:generate go tool oapi-codegen -config config.yaml ../../api/openapi.yaml

package api

import (
	"encoding/json"
	"net/http"
)

// WriteJSON writes a JSON response
func WriteJSON(w http.ResponseWriter, status int, data interface{}) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	json.NewEncoder(w).Encode(data)
}

// WriteError writes an error response
// func WriteError(w http.ResponseWriter, status int, message string) {
// 	WriteJSON(w, status, api.ErrorResponse{
// 		Code:  status,
// 		Error: message,
// 	})
// }

// ReadJSON reads JSON from a request body
func ReadJSON(r *http.Request, v interface{}) error {
	return json.NewDecoder(r.Body).Decode(v)
}
