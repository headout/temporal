package visibility

import (
	"context"
	"testing"
	"time"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
	"go.temporal.io/server/api/visibilityservice/v1"
	"go.temporal.io/server/common/log"
	"go.temporal.io/server/common/namespace"
	"go.temporal.io/server/common/persistence/visibility/manager"
)

type mockVisibilityManager struct {
	listCallCount  int
	countCallCount int
	listResponse   *manager.ListWorkflowExecutionsResponse
	countResponse  *manager.CountWorkflowExecutionsResponse
}

func (m *mockVisibilityManager) Close()                                              {}
func (m *mockVisibilityManager) GetReadStoreName(namespace.Name) string              { return "test" }
func (m *mockVisibilityManager) GetStoreNames() []string                             { return []string{"test"} }
func (m *mockVisibilityManager) HasStoreName(string) bool                            { return true }
func (m *mockVisibilityManager) GetIndexName() string                                { return "test-index" }
func (m *mockVisibilityManager) ValidateCustomSearchAttributes(map[string]any) (map[string]any, error) {
	return nil, nil
}

func (m *mockVisibilityManager) RecordWorkflowExecutionStarted(context.Context, *manager.RecordWorkflowExecutionStartedRequest) error {
	return nil
}

func (m *mockVisibilityManager) RecordWorkflowExecutionClosed(context.Context, *manager.RecordWorkflowExecutionClosedRequest) error {
	return nil
}

func (m *mockVisibilityManager) UpsertWorkflowExecution(context.Context, *manager.UpsertWorkflowExecutionRequest) error {
	return nil
}

func (m *mockVisibilityManager) DeleteWorkflowExecution(context.Context, *manager.VisibilityDeleteWorkflowExecutionRequest) error {
	return nil
}

func (m *mockVisibilityManager) ListWorkflowExecutions(context.Context, *manager.ListWorkflowExecutionsRequestV2) (*manager.ListWorkflowExecutionsResponse, error) {
	m.listCallCount++
	return m.listResponse, nil
}

func (m *mockVisibilityManager) CountWorkflowExecutions(context.Context, *manager.CountWorkflowExecutionsRequest) (*manager.CountWorkflowExecutionsResponse, error) {
	m.countCallCount++
	return m.countResponse, nil
}

func (m *mockVisibilityManager) GetWorkflowExecution(context.Context, *manager.GetWorkflowExecutionRequest) (*manager.GetWorkflowExecutionResponse, error) {
	return nil, nil
}

func (m *mockVisibilityManager) ListChasmExecutions(context.Context, *visibilityservice.ListChasmExecutionsRequest) (*visibilityservice.ListChasmExecutionsResponse, error) {
	return nil, nil
}

func (m *mockVisibilityManager) CountChasmExecutions(context.Context, *visibilityservice.CountChasmExecutionsRequest) (*visibilityservice.CountChasmExecutionsResponse, error) {
	return nil, nil
}

func (m *mockVisibilityManager) AddSearchAttributes(context.Context, *manager.AddSearchAttributesRequest) error {
	return nil
}

func TestCachingVisibilityManager_Disabled(t *testing.T) {
	mock := &mockVisibilityManager{}
	
	// When caching is disabled, should return the delegate directly
	vm := NewCachingVisibilityManager(mock, false, 20, log.NewNoopLogger(), nil)
	
	assert.Equal(t, mock, vm, "Should return delegate when caching is disabled")
}

func TestCachingVisibilityManager_ListWorkflowExecutions_Cache(t *testing.T) {
	mock := &mockVisibilityManager{
		listResponse: &manager.ListWorkflowExecutionsResponse{
			Executions: nil,
		},
	}
	
	vm := NewCachingVisibilityManager(mock, true, 20, log.NewNoopLogger(), nil)
	ctx := context.Background()
	
	nsID := namespace.ID("test-namespace")
	request := &manager.ListWorkflowExecutionsRequestV2{
		NamespaceID: nsID,
		Query:       "WorkflowType='test'",
		PageSize:    10,
	}
	
	// First call - should hit the delegate
	resp1, err := vm.ListWorkflowExecutions(ctx, request)
	require.NoError(t, err)
	require.NotNil(t, resp1)
	assert.Equal(t, 1, mock.listCallCount, "First call should hit delegate")
	
	// Second call with same params - should hit cache
	resp2, err := vm.ListWorkflowExecutions(ctx, request)
	require.NoError(t, err)
	require.NotNil(t, resp2)
	assert.Equal(t, 1, mock.listCallCount, "Second call should hit cache, not delegate")
	
	// Different query - should hit delegate again
	request.Query = "WorkflowType='different'"
	resp3, err := vm.ListWorkflowExecutions(ctx, request)
	require.NoError(t, err)
	require.NotNil(t, resp3)
	assert.Equal(t, 2, mock.listCallCount, "Different query should hit delegate")
}

func TestCachingVisibilityManager_CountWorkflowExecutions_Cache(t *testing.T) {
	mock := &mockVisibilityManager{
		countResponse: &manager.CountWorkflowExecutionsResponse{
			Count: 42,
		},
	}
	
	vm := NewCachingVisibilityManager(mock, true, 20, log.NewNoopLogger(), nil)
	ctx := context.Background()
	
	nsID := namespace.ID("test-namespace")
	request := &manager.CountWorkflowExecutionsRequest{
		NamespaceID: nsID,
		Query:       "ExecutionStatus='Running'",
	}
	
	// First call - should hit the delegate
	resp1, err := vm.CountWorkflowExecutions(ctx, request)
	require.NoError(t, err)
	require.NotNil(t, resp1)
	assert.Equal(t, int64(42), resp1.Count)
	assert.Equal(t, 1, mock.countCallCount, "First call should hit delegate")
	
	// Second call with same params - should hit cache
	resp2, err := vm.CountWorkflowExecutions(ctx, request)
	require.NoError(t, err)
	require.NotNil(t, resp2)
	assert.Equal(t, int64(42), resp2.Count)
	assert.Equal(t, 1, mock.countCallCount, "Second call should hit cache, not delegate")
}

func TestCachingVisibilityManager_SchedulerQuery_DifferentTTL(t *testing.T) {
	mock := &mockVisibilityManager{
		countResponse: &manager.CountWorkflowExecutionsResponse{
			Count: 10,
		},
	}
	
	vm := NewCachingVisibilityManager(mock, true, 20, log.NewNoopLogger(), nil).(*cachingVisibilityManager)
	ctx := context.Background()
	
	nsID := namespace.ID("test-namespace")
	
	// Regular query
	regularRequest := &manager.CountWorkflowExecutionsRequest{
		NamespaceID: nsID,
		Query:       "ExecutionStatus='Running'",
	}
	
	// Scheduler query
	schedulerRequest := &manager.CountWorkflowExecutionsRequest{
		NamespaceID: nsID,
		Query:       "TemporalNamespaceDivision='TemporalScheduler' AND status=1",
	}
	
	// Execute both queries
	_, _ = vm.CountWorkflowExecutions(ctx, regularRequest)
	_, _ = vm.CountWorkflowExecutions(ctx, schedulerRequest)
	
	// Check cache entries have different TTLs
	vm.mu.RLock()
	defer vm.mu.RUnlock()
	
	// We can't easily verify the exact TTL, but we can verify both are cached
	assert.Equal(t, 2, len(vm.cache), "Both queries should be cached")
}

func TestCachingVisibilityManager_CacheExpiry(t *testing.T) {
	mock := &mockVisibilityManager{
		listResponse: &manager.ListWorkflowExecutionsResponse{
			Executions: nil,
		},
	}
	
	// Use very short TTL for testing
	vm := NewCachingVisibilityManager(mock, true, 1, log.NewNoopLogger(), nil)
	ctx := context.Background()
	
	nsID := namespace.ID("test-namespace")
	request := &manager.ListWorkflowExecutionsRequestV2{
		NamespaceID: nsID,
		Query:       "WorkflowType='test'",
		PageSize:    10,
	}
	
	// First call
	_, err := vm.ListWorkflowExecutions(ctx, request)
	require.NoError(t, err)
	assert.Equal(t, 1, mock.listCallCount)
	
	// Wait for cache to expire (TTL is 1 second, but list uses 15 seconds hardcoded)
	// So we need to wait longer
	time.Sleep(16 * time.Second)
	
	// Second call after expiry - should hit delegate again
	_, err = vm.ListWorkflowExecutions(ctx, request)
	require.NoError(t, err)
	assert.Equal(t, 2, mock.listCallCount, "After expiry should hit delegate again")
}

func TestCachingVisibilityManager_InvalidationOnWrite(t *testing.T) {
	mock := &mockVisibilityManager{
		listResponse: &manager.ListWorkflowExecutionsResponse{
			Executions: nil,
		},
		countResponse: &manager.CountWorkflowExecutionsResponse{
			Count: 5,
		},
	}
	
	vm := NewCachingVisibilityManager(mock, true, 20, log.NewNoopLogger(), nil)
	ctx := context.Background()
	
	nsID := namespace.ID("test-namespace")
	
	// Populate cache with list and count
	listReq := &manager.ListWorkflowExecutionsRequestV2{
		NamespaceID: nsID,
		Query:       "WorkflowType='test'",
		PageSize:    10,
	}
	countReq := &manager.CountWorkflowExecutionsRequest{
		NamespaceID: nsID,
		Query:       "ExecutionStatus='Running'",
	}
	
	_, _ = vm.ListWorkflowExecutions(ctx, listReq)
	_, _ = vm.CountWorkflowExecutions(ctx, countReq)
	
	assert.Equal(t, 1, mock.listCallCount)
	assert.Equal(t, 1, mock.countCallCount)
	
	// Perform a write operation (upsert)
	upsertReq := &manager.UpsertWorkflowExecutionRequest{
		VisibilityRequestBase: &manager.VisibilityRequestBase{
			NamespaceID: nsID,
		},
	}
	err := vm.UpsertWorkflowExecution(ctx, upsertReq)
	require.NoError(t, err)
	
	// Cache should be invalidated - next calls should hit delegate
	_, _ = vm.ListWorkflowExecutions(ctx, listReq)
	_, _ = vm.CountWorkflowExecutions(ctx, countReq)
	
	assert.Equal(t, 2, mock.listCallCount, "After invalidation, list should hit delegate")
	assert.Equal(t, 2, mock.countCallCount, "After invalidation, count should hit delegate")
}

func TestCachingVisibilityManager_InvalidationOnDelete(t *testing.T) {
	mock := &mockVisibilityManager{
		countResponse: &manager.CountWorkflowExecutionsResponse{
			Count: 3,
		},
	}
	
	vm := NewCachingVisibilityManager(mock, true, 20, log.NewNoopLogger(), nil)
	ctx := context.Background()
	
	nsID := namespace.ID("test-namespace")
	
	// Populate cache
	countReq := &manager.CountWorkflowExecutionsRequest{
		NamespaceID: nsID,
		Query:       "ExecutionStatus='Running'",
	}
	
	_, _ = vm.CountWorkflowExecutions(ctx, countReq)
	assert.Equal(t, 1, mock.countCallCount)
	
	// Delete workflow
	deleteReq := &manager.VisibilityDeleteWorkflowExecutionRequest{
		NamespaceID: nsID,
		RunID:       "test-run-id",
	}
	err := vm.DeleteWorkflowExecution(ctx, deleteReq)
	require.NoError(t, err)
	
	// Cache should be invalidated
	_, _ = vm.CountWorkflowExecutions(ctx, countReq)
	assert.Equal(t, 2, mock.countCallCount, "After delete, should hit delegate")
}

func TestCachingVisibilityManager_PassthroughMethods(t *testing.T) {
	mock := &mockVisibilityManager{}
	vm := NewCachingVisibilityManager(mock, true, 20, log.NewNoopLogger(), nil)
	
	// Test that non-cached methods pass through correctly
	assert.Equal(t, "test", vm.GetReadStoreName(namespace.Name("test")))
	assert.Equal(t, []string{"test"}, vm.GetStoreNames())
	assert.True(t, vm.HasStoreName("test"))
	assert.Equal(t, "test-index", vm.GetIndexName())
	
	ctx := context.Background()
	
	// GetWorkflowExecution should not be cached
	_, err := vm.GetWorkflowExecution(ctx, &manager.GetWorkflowExecutionRequest{})
	require.NoError(t, err)
}

func TestCachingVisibilityManager_CacheKeyUniqueness(t *testing.T) {
	mock := &mockVisibilityManager{
		listResponse: &manager.ListWorkflowExecutionsResponse{},
	}
	
	vm := NewCachingVisibilityManager(mock, true, 20, log.NewNoopLogger(), nil).(*cachingVisibilityManager)
	ctx := context.Background()
	
	nsID := namespace.ID("test-namespace")
	
	// Different queries should have different cache keys
	req1 := &manager.ListWorkflowExecutionsRequestV2{
		NamespaceID: nsID,
		Query:       "WorkflowType='test1'",
		PageSize:    10,
	}
	req2 := &manager.ListWorkflowExecutionsRequestV2{
		NamespaceID: nsID,
		Query:       "WorkflowType='test2'",
		PageSize:    10,
	}
	req3 := &manager.ListWorkflowExecutionsRequestV2{
		NamespaceID: nsID,
		Query:       "WorkflowType='test1'",
		PageSize:    20, // Different page size
	}
	
	_, _ = vm.ListWorkflowExecutions(ctx, req1)
	_, _ = vm.ListWorkflowExecutions(ctx, req2)
	_, _ = vm.ListWorkflowExecutions(ctx, req3)
	
	vm.mu.RLock()
	defer vm.mu.RUnlock()
	
	assert.Equal(t, 3, len(vm.cache), "Different requests should create different cache entries")
}
